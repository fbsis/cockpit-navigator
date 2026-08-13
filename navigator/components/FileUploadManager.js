/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 Josh Boudreau, Sam Silver, Dawson Della Valle
	Distributed under the GNU General Public License, version 3 or later.
*/

import { format_bytes } from "../functions.js";

const FINAL_STATES = new Set(["completed", "skipped", "cancelled", "error"]);

export class FileUploadManager {
	constructor(nav_window_ref, max_concurrent = 3) {
		this.nav_window_ref = nav_window_ref;
		this.max_concurrent = max_concurrent;
		this.running = 0;
		this.queue = [];
		this.batches = [];
		this.rows = new Map();
		this.modal = document.getElementById("nav-upload-modal");
		this.list = document.getElementById("nav-upload-list");
		this.summary = document.getElementById("nav-upload-summary");
		this.destination = document.getElementById("nav-upload-destination");
		this.total_progress = document.getElementById("nav-upload-total-progress");
		this.compact = document.getElementById("nav-upload-compact");
		this.compact_text = document.getElementById("nav-upload-compact-text");
		this.clear_button = document.getElementById("nav-upload-clear");
		this.cancel_all_button = document.getElementById("nav-upload-cancel-all");
		document.getElementById("nav-upload-close").onclick = () => this.hide();
		this.cancel_all_button.onclick = () => this.cancel_all();
		this.clear_button.onclick = () => this.clear_finished();
		this.compact.onclick = () => this.show();
		window.addEventListener("keydown", event => {
			if (event.key === "Escape" && this.modal.style.display === "flex") this.hide();
		});
		this.update_totals();
	}

	show() {
		this.modal.style.display = "flex";
		this.compact.hidden = true;
	}

	set_preparing(message = "") {
		this.preparing = message;
		this.update_totals();
	}

	hide() {
		this.modal.style.display = "none";
		this.update_compact();
	}

	add(uploads, destination) {
		if (!uploads?.length) return;
		const batch = { id: Date.now() + Math.random(), destination, uploads, notified: false };
		this.batches.push(batch);
		for (const upload of uploads) {
			upload.batch = batch;
			upload.on_update = () => this.update_upload(upload);
			this.create_row(upload);
			if (upload.state === "queued") this.queue.push(upload);
		}
		this.show();
		this.update_totals();
		this.run_next();
		this.check_batch(batch);
	}

	create_row(upload) {
		const row = document.createElement("div");
		row.className = "nav-upload-row";
		const top = document.createElement("div");
		top.className = "nav-upload-row-top";
		const name = document.createElement("span");
		name.className = "nav-upload-name";
		name.textContent = upload.filename;
		name.title = upload.filename;
		const state = document.createElement("span");
		state.className = "nav-upload-state";
		top.append(name, state);
		const progress = document.createElement("progress");
		progress.max = 100;
		const details = document.createElement("div");
		details.className = "nav-upload-details";
		const metrics = document.createElement("span");
		const actions = document.createElement("span");
		actions.className = "nav-upload-actions";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "pf-c-button pf-m-secondary";
		cancel.innerHTML = '<i class="fas fa-times"></i>';
		cancel.title = "Cancel upload";
		cancel.onclick = () => {
			upload.cancel();
			this.queue = this.queue.filter(item => item !== upload);
			this.update_upload(upload);
			this.run_next();
		};
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "pf-c-button pf-m-secondary";
		retry.innerHTML = '<i class="fas fa-redo"></i>';
		retry.title = "Retry upload";
		retry.onclick = () => this.retry(upload);
		actions.append(cancel, retry);
		details.append(metrics, actions);
		const error = document.createElement("div");
		error.className = "nav-upload-error";
		row.append(top, progress, details, error);
		this.list.appendChild(row);
		this.rows.set(upload, { row, state, progress, metrics, cancel, retry, error });
		this.update_upload(upload);
	}

	update_upload(upload) {
		const elements = this.rows.get(upload);
		if (!elements) return;
		const labels = {
			queued: "Queued", uploading: "Uploading", completed: "Completed",
			skipped: "Skipped", cancelled: "Cancelled", error: "Error",
		};
		elements.state.textContent = labels[upload.state] || upload.state;
		elements.state.dataset.state = upload.state;
		elements.progress.value = upload.progress_percent();
		const sent = `${format_bytes(upload.bytes_sent)} / ${format_bytes(upload.file.size)}`;
		const speed = upload.rate_avg ? cockpit.format_bytes_per_sec(upload.rate_avg) : "-";
		elements.metrics.textContent = `${sent} · ${speed} · ETA ${upload.eta_text()}`;
		elements.cancel.hidden = !["queued", "uploading"].includes(upload.state);
		elements.retry.hidden = !upload.can_retry || !["error", "cancelled"].includes(upload.state);
		elements.error.textContent = upload.error || "";
		elements.error.hidden = !upload.error;
		this.update_totals();
		this.check_batch(upload.batch);
	}

	run_next() {
		while (this.running < this.max_concurrent && this.queue.length) {
			const upload = this.queue.shift();
			if (upload.state !== "queued") continue;
			this.running++;
			upload.upload().finally(() => {
				this.running--;
				this.check_batch(upload.batch);
				this.run_next();
			});
		}
		this.update_totals();
	}

	retry(upload) {
		if (!["error", "cancelled"].includes(upload.state)) return;
		upload.batch.notified = false;
		upload.reset();
		this.queue.push(upload);
		this.run_next();
	}

	cancel_all() {
		for (const batch of this.batches) {
			for (const upload of batch.uploads) {
				if (["queued", "uploading"].includes(upload.state)) upload.cancel();
			}
		}
		this.queue = [];
		this.update_totals();
		for (const batch of this.batches) this.check_batch(batch);
	}

	clear_finished() {
		if (this.running || this.queue.length) return;
		this.batches = [];
		this.rows.clear();
		this.list.replaceChildren();
		this.update_totals();
		this.hide();
		this.compact.hidden = true;
	}

	all_uploads() {
		return this.batches.flatMap(batch => batch.uploads);
	}

	update_totals() {
		const uploads = this.all_uploads();
		const total = uploads.reduce((sum, upload) => sum + upload.file.size, 0);
		const sent = uploads.reduce((sum, upload) => sum + (
			["completed", "skipped"].includes(upload.state)
				? upload.file.size
				: Math.min(upload.bytes_sent, upload.file.size)
		), 0);
		const completed = uploads.filter(upload => upload.state === "completed").length;
		this.summary.textContent = this.preparing || (uploads.length
			? `${uploads.length} item${uploads.length === 1 ? "" : "s"} · ${format_bytes(total)} · ${completed} completed`
			: "No uploads");
		const destinations = [...new Set(this.batches.map(batch => batch.destination))];
		this.destination.textContent = destinations.length === 1 ? `Destination: ${destinations[0]}`
			: destinations.length > 1 ? "Multiple destinations" : "";
		this.total_progress.max = Math.max(total, 1);
		this.total_progress.value = sent;
		this.clear_button.disabled = Boolean(this.running || this.queue.length || !uploads.length);
		this.cancel_all_button.disabled = !uploads.some(upload => ["queued", "uploading"].includes(upload.state));
		this.update_compact();
	}

	update_compact() {
		const uploads = this.all_uploads();
		if (!uploads.length || this.modal.style.display === "flex") {
			this.compact.hidden = true;
			return;
		}
		const pending = uploads.filter(upload => !FINAL_STATES.has(upload.state)).length;
		this.compact_text.textContent = pending ? `${pending} upload${pending === 1 ? "" : "s"} remaining` : "Upload details";
		this.compact.hidden = false;
	}

	check_batch(batch) {
		if (!batch || batch.notified || !batch.uploads.every(upload => FINAL_STATES.has(upload.state))) return;
		batch.notified = true;
		const counts = Object.fromEntries([...FINAL_STATES].map(state => [state, batch.uploads.filter(item => item.state === state).length]));
		this.refresh_destination(batch.destination);
		this.show_final_alert(batch, counts);
	}

	refresh_destination(destination) {
		const manager = this.nav_window_ref.tab_manager;
		const active = manager?.active_tab();
		if (active?.type === "directory" && manager.current_path(active) === destination)
			this.nav_window_ref.refresh();
	}

	phrase(count, singular, plural = `${singular}s`) {
		return `${count} ${count === 1 ? singular : plural}`;
	}

	show_final_alert(batch, counts) {
		let title;
		if (counts.error) {
			title = "Upload finished with errors";
		} else if (counts.cancelled) {
			title = "Upload cancelled";
		} else {
			title = "Upload completed";
		}
		const parts = [];
		if (counts.completed) parts.push(`${counts.completed} uploaded`);
		if (counts.skipped) parts.push(`${counts.skipped} skipped`);
		if (counts.error) parts.push(`${counts.error} failed`);
		if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
		const message = counts.completed === batch.uploads.length
			? `${this.phrase(counts.completed, "item")} uploaded.`
			: `${parts.join(", ")}.`;
		const toast = document.createElement("button");
		toast.type = "button";
		toast.className = `nav-upload-toast${counts.error || counts.cancelled ? " nav-upload-toast-warning" : ""}`;
		const heading = document.createElement("strong");
		heading.textContent = `${title}:`;
		const text = document.createElement("span");
		text.textContent = ` ${message}`;
		toast.append(heading, text);
		toast.onclick = () => {
			toast.remove();
			this.show();
		};
		document.getElementById("nav-upload-toasts").appendChild(toast);
		setTimeout(() => toast.remove(), counts.error || counts.cancelled ? 15000 : 7000);
	}
}
