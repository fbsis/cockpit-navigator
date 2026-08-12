import { format_bytes } from "../functions.js";

export class DirectorySizeManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.process = null;
		this.generation = 0;
	}

	cancel() {
		this.generation++;
		if (this.process) {
			this.process.close("terminated");
			this.process = null;
		}
	}

	start(entries) {
		this.cancel();
		const directories = entries.filter(entry => entry.nav_type === "dir" && entry.visible);
		if (!directories.length) return;
		const generation = this.generation;
		const by_path = new Map(directories.map(entry => [entry.path_str(), entry]));
		for (const entry of directories) this.render(entry, 0, "progress");
		const command = ["/usr/share/cockpit/navigator/scripts/directory-sizes.py3", ...by_path.keys()];
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
		entry.stat.size = bytes;
		let element = entry.dom_element.nav_item_size;
		if (!element) {
			element = document.createElement("div");
			element.className = "nav-dir-size-badge";
			entry.dom_element.appendChild(element);
		}
		const icon = state === "timeout"
			? '<i class="fas fa-hourglass-end nav-dir-size-timeout"></i> '
			: state === "progress" ? '<i class="fas fa-spinner fa-spin"></i> ' : "";
		element.innerHTML = icon + format_bytes(bytes);
		element.title = state === "timeout"
			? "Size calculation stopped after 10 seconds. Open this folder to calculate its children instead."
			: state === "progress" ? "Calculating folder size…" : "Calculated folder size";
	}
}
