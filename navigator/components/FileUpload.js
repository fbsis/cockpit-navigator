/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 Josh Boudreau, Sam Silver, Dawson Della Valle
	Distributed under the GNU General Public License, version 3 or later.
*/

import { format_time_remaining } from "../functions.js";

export class FileUpload {
	constructor(file, destination, relative_path = file.name) {
		try {
			this.chunk_size = parseInt(cockpit.info.version) > 238 ? 1048576 : 65536;
		} catch (_) {
			this.chunk_size = 65536;
		}
		this.file = file;
		this.filename = relative_path.replace(/^\/+/, "");
		this.destination = destination.replace(/\/$/, "") || "/";
		this.path = `${this.destination}/${this.filename}`.replace(/^\/\//, "/");
		this.state = "queued";
		this.bytes_sent = 0;
		this.rate_avg = 0;
		this.eta = 0;
		this.progress_timestamp = undefined;
		this.error = "";
		this.proc = null;
		this.cancelled = false;
		this.transport_closed = false;
		this.replace_existing = false;
		this.can_retry = true;
		this.on_update = () => {};
	}

	update() {
		this.on_update(this);
	}

	progress_percent() {
		return this.file.size ? Math.min(100, (this.bytes_sent / this.file.size) * 100) : (this.state === "completed" ? 100 : 0);
	}

	eta_text() {
		return this.eta > 0 && Number.isFinite(this.eta) ? format_time_remaining(this.eta) : "-";
	}

	reset() {
		this.cancelled = false;
		this.transport_closed = false;
		this.state = "queued";
		this.bytes_sent = 0;
		this.rate_avg = 0;
		this.eta = 0;
		this.progress_timestamp = undefined;
		this.error = "";
		this.update();
	}

	cancel() {
		this.cancelled = true;
		if (this.reader?.readyState === FileReader.LOADING)
			this.reader.abort();
		if (this.state === "queued") {
			this.state = "cancelled";
			this.update();
		} else if (this.state === "uploading" && this.proc) {
			this.proc.close("terminated");
		}
	}

	read_chunk(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			this.reader = reader;
			reader.onload = () => resolve(new Uint8Array(reader.result));
			reader.onerror = () => reject(reader.error || new Error("Could not read local file."));
			reader.onabort = () => reject(new Error("Upload cancelled."));
			reader.readAsArrayBuffer(blob);
		});
	}

	encode(bytes) {
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
		return btoa(binary);
	}

	failure_message(output, error) {
		const lines = String(output || "").trim().split("\n").filter(Boolean);
		for (let index = lines.length - 1; index >= 0; index--) {
			try {
				const event = JSON.parse(lines[index]);
				if (event.message) return event.message;
			} catch (_) { /* plain process output */ }
		}
		return String(output || error || "Upload failed.").trim();
	}

	async send_chunks(proc) {
		let offset = 0;
		while (offset < this.file.size) {
			if (this.cancelled) throw new Error("Upload cancelled.");
			if (this.transport_closed) throw new Error("Upload connection closed.");
			const bytes = await this.read_chunk(this.file.slice(offset, offset + this.chunk_size));
			if (this.cancelled) throw new Error("Upload cancelled.");
			if (this.transport_closed) throw new Error("Upload connection closed.");
			proc.input(JSON.stringify({ seek: offset, chunk: this.encode(bytes) }) + "\n", true);
			offset += bytes.length;
		}
		proc.input();
	}

	handle_process_event(event) {
		if (event.event === "error" && event.message) {
			this.process_error = event.message;
			return;
		}
		if (event.event !== "progress") return;
		const now = performance.now();
		const bytes = Math.max(this.bytes_sent, Number(event.bytes) || 0);
		if (this.progress_timestamp !== undefined && bytes > this.bytes_sent) {
			const elapsed = Math.max((now - this.progress_timestamp) / 1000, 0.001);
			const rate = (bytes - this.bytes_sent) / elapsed;
			this.rate_avg = this.rate_avg ? 0.125 * rate + 0.875 * this.rate_avg : rate;
		}
		this.progress_timestamp = now;
		this.bytes_sent = bytes;
		this.eta = this.rate_avg ? (this.file.size - bytes) / this.rate_avg : 0;
		this.update();
	}

	upload() {
		this.cancelled = false;
		this.transport_closed = false;
		this.state = "uploading";
		this.error = "";
		this.process_error = "";
		this.progress_timestamp = performance.now();
		this.update();
		return new Promise(resolve => {
			const proc = this.proc = cockpit.spawn(
				["/usr/share/cockpit/navigator/scripts/write-chunks.py3", this.path, String(this.file.size), this.replace_existing ? "replace" : "no-replace"],
				{ err: "out", superuser: "try" },
			);
			let output_buffer = "";
			proc.stream(data => {
				output_buffer += data;
				const lines = output_buffer.split("\n");
				output_buffer = lines.pop();
				for (const line of lines) {
					if (!line.trim()) continue;
					try { this.handle_process_event(JSON.parse(line)); } catch (_) { /* handled on process failure */ }
				}
			});
			proc.done(() => {
				this.transport_closed = true;
				this.bytes_sent = this.file.size;
				this.state = "completed";
				this.eta = 0;
				this.update();
				resolve(this.state);
			});
			proc.fail((error, output) => {
				this.transport_closed = true;
				this.state = this.cancelled ? "cancelled" : "error";
				this.error = this.cancelled ? "Upload cancelled." : (this.process_error || this.failure_message(output, error));
				this.update();
				resolve(this.state);
			});
			this.send_chunks(proc).catch(error => {
				this.error = error.message || String(error);
				if (!this.cancelled) proc.close("terminated");
			});
		}).finally(() => {
			this.proc = null;
			this.reader = null;
		});
	}
}
