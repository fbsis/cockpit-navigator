import { format_bytes } from "../functions.js";

export class DirectorySizeManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.process = null;
		this.generation = 0;
		window.addEventListener("pagehide", () => this.cancel());
		cockpit.addEventListener?.("visibilitychange", () => {
			if (cockpit.hidden) this.cancel();
		});
	}

	cancel() {
		this.generation++;
		if (this.process) {
			this.process.close("terminated");
			this.process = null;
		}
	}

	start(entries, timeout = 10, method = "incremental", force = false) {
		this.cancel();
		const directories = entries.filter(entry => entry.nav_type === "dir" && entry.visible);
		if (!directories.length) return;
		if (this.nav_window_ref.pwd().path_str() === "/" && !force) {
			for (const entry of directories) this.render(entry, null, "root-deferred");
			return;
		}
		const generation = this.generation;
		const by_path = new Map(directories.map(entry => [entry.path_str(), entry]));
		for (const entry of directories)
			this.render(entry, method === "du" ? null : 0, method === "du" ? "calculating" : "progress");
		const command = [
			"/usr/share/cockpit/navigator/scripts/directory-sizes.py3",
			"--timeout", String(timeout), "--method", method, ...by_path.keys(),
		];
		const process = this.process = cockpit.spawn(command, { superuser: "try", err: "ignore" });
		let buffer = "";
		process.stream(data => {
			if (generation !== this.generation) return;
			buffer += data;
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					const entry = by_path.get(event.path);
					if (entry) this.render(entry, Number(event.bytes) || 0, event.event);
				} catch (error) {
					console.warn("Invalid directory size update.", error);
				}
			}
		});
		process.always(() => {
			if (this.process === process) this.process = null;
		});
	}

	render(entry, bytes, state) {
		if (bytes !== null) entry.stat.size = bytes;
		let element = entry.dom_element.nav_item_size;
		if (!element) {
			element = document.createElement("div");
			element.className = "nav-dir-size-badge";
			entry.dom_element.appendChild(element);
		}
		const icon = state === "timeout"
			? '<i class="fas fa-hourglass-end nav-dir-size-timeout"></i> '
			: state === "root-deferred" ? '<i class="fas fa-hourglass-half nav-dir-size-timeout"></i> '
			: ["progress", "calculating"].includes(state) ? '<i class="fas fa-spinner fa-spin"></i> ' : "";
		element.innerHTML = state === "calculating" ? icon + "Calculating…"
			: state === "root-deferred" ? icon + "Not calculated" : icon + format_bytes(bytes);
		element.classList.toggle("nav-dir-size-retry", ["timeout", "root-deferred"].includes(state));
		element.title = state === "timeout"
			? "Stopped after the time limit. Click to retry this folder for up to 5 minutes."
			: state === "root-deferred"
				? "Automatic size calculation is disabled at the Linux root to avoid scanning large system trees. Click to calculate only this folder."
			: ["progress", "calculating"].includes(state) ? "Calculating folder size…" : "Calculated folder size";
		element.onclick = ["timeout", "root-deferred"].includes(state) ? async event => {
			event.preventDefault();
			event.stopPropagation();
			const fromRoot = state === "root-deferred";
			const retry = await this.nav_window_ref.modal_prompt.confirm(
				fromRoot ? `Calculate ${entry.path_str()}?` : "Calculate this folder for up to 5 minutes?",
				fromRoot
					? "Automatic calculation is disabled at the Linux root because system directories may be very large. Only this selected folder will be scanned, for up to 5 minutes."
					: "The calculation will stop immediately if you leave this screen.",
			);
			if (retry && entry.dom_element.isConnected && entry.visible)
				this.start([entry], 300, "du", true);
		} : null;
	}
}
