import { ModalPrompt } from "./ModalPrompt.js";

export class TransferManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.queue = [];
		this.active = null;
		this.next_id = 1;
		this.modal = new ModalPrompt();
		this.notifications = document.getElementById("nav-notifications");
	}

	directory_tabs() {
		return (this.nav_window_ref.tab_manager?.tabs || [])
			.filter(tab => tab.type === "directory")
			.map(tab => ({ tab, path: this.nav_window_ref.tab_manager.current_path(tab) }));
	}

	async choose_destination() {
		const tabs = this.directory_tabs();
		if (!tabs.length) {
			await this.modal.alert("No destination available", "Open a directory tab first.");
			return null;
		}
		const choices = tabs.map(({ tab, path }, index) => ({
			label: `${path === "/" ? "/" : path.split("/").filter(Boolean).pop()} — ${path}`,
			value: { tab_id: tab.id, path },
			primary: index === 0,
		}));
		choices.push({ label: "Cancel", value: null });
		return this.modal.choose("Choose destination", "Select an open directory tab.", choices);
	}

	async enqueue_from_clipboard(destination = null) {
		if (!this.nav_window_ref.clip_board.length)
			return;
		destination ||= await this.choose_destination();
		if (!destination)
			return;
		this.enqueue({
			type: this.nav_window_ref.copy_or_move,
			sources: this.nav_window_ref.clip_board.map(item => item.path_str()),
			source_root: this.nav_window_ref.paste_cwd,
			destination: destination.path,
			destination_tab_id: destination.tab_id,
			from_clipboard: true,
		});
	}

	async enqueue_selection(type) {
		if (this.nav_window_ref.none_selected())
			return;
		if (type === "move" && await this.nav_window_ref.check_if_dangerous("move"))
			return;
		const destination = await this.choose_destination();
		if (!destination)
			return;
		this.enqueue({
			type,
			sources: [...this.nav_window_ref.selected_entries].map(item => item.path_str()),
			source_root: this.nav_window_ref.pwd().path_str(),
			destination: destination.path,
			destination_tab_id: destination.tab_id,
			from_clipboard: false,
		});
	}

	enqueue(operation) {
		operation.id = this.next_id++;
		operation.state = "queued";
		operation.card = this.make_card(operation);
		this.queue.push(operation);
		this.update_card(operation, { event: "queued" });
		this.run_next();
	}

	make_card(operation) {
		const card = document.createElement("div");
		card.className = "nav-notification nav-transfer-notification";
		const header = document.createElement("div");
		header.className = "nav-notification-header nav-transfer-header";
		const title = document.createElement("p");
		title.textContent = `${operation.type === "move" ? "Moving" : "Copying"} ${operation.sources.length} item${operation.sources.length === 1 ? "" : "s"}`;
		title.title = `${operation.source_root} → ${operation.destination}`;
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "nav-transfer-cancel";
		cancel.title = "Cancel transfer";
		cancel.setAttribute("aria-label", "Cancel transfer");
		cancel.innerHTML = '<i class="fas fa-times"></i>';
		cancel.onclick = () => this.request_cancel(operation);
		header.append(title, cancel);
		const current = document.createElement("div");
		current.className = "nav-transfer-current";
		current.textContent = "Waiting…";
		const details = document.createElement("div");
		details.className = "nav-transfer-details monospace-sm";
		const rate = document.createElement("span");
		const eta = document.createElement("span");
		details.append(rate, eta);
		const progress = document.createElement("progress");
		progress.max = 100;
		progress.value = 0;
		card.append(header, current, details, progress);
		card._parts = { title, cancel, current, rate, eta, progress };
		this.notifications.appendChild(card);
		return card;
	}

	update_card(operation, event) {
		const parts = operation.card._parts;
		operation.card.style.display = "flex";
		if (event.event === "queued") {
			parts.current.textContent = "Queued";
			parts.rate.textContent = "-";
			parts.eta.textContent = "-";
		} else if (event.event === "progress") {
			parts.current.textContent = event.file || "Transferring…";
			parts.current.title = event.file || "";
			parts.progress.value = event.percent || 0;
			parts.rate.textContent = event.speed || "-";
			parts.eta.textContent = event.eta ? `ETA ${event.eta}` : "-";
		} else if (event.event === "completed") {
			parts.current.textContent = "Completed";
			parts.progress.value = 100;
			parts.cancel.innerHTML = '<i class="fas fa-check"></i>';
			parts.cancel.title = "Dismiss";
			parts.cancel.onclick = () => operation.card.remove();
		} else if (event.event === "cancelled") {
			parts.current.textContent = event.cleanup ? "Cancelled — partial copy removed" : "Cancelled — partial copy kept";
			parts.cancel.innerHTML = '<i class="fas fa-times"></i>';
			parts.cancel.title = "Dismiss";
			parts.cancel.onclick = () => operation.card.remove();
		} else if (event.event === "error") {
			parts.current.textContent = event.message || "Transfer failed";
			parts.current.title = event.details || event.message || "";
			operation.card.classList.add("nav-transfer-error");
			parts.cancel.title = "Dismiss";
			parts.cancel.onclick = () => operation.card.remove();
		}
	}

	async request_cancel(operation) {
		if (operation.state === "queued") {
			this.queue = this.queue.filter(item => item !== operation);
			this.update_card(operation, { event: "cancelled", cleanup: true });
			return;
		}
		if (operation !== this.active || operation.cancelling)
			return;
		const action = await this.modal.choose(
			"Cancel transfer?",
			"The source will be preserved. What should happen to files already copied?",
			[
				{ label: "Keep files already copied", value: "keep" },
				{ label: "Remove partial copy", value: "remove", danger: true },
				{ label: "Continue transfer", value: "continue", primary: true },
			]
		);
		if (action === "continue")
			return;
		operation.cancelling = true;
		operation.proc?.input(JSON.stringify({ action: "cancel", cleanup: action === "remove" }) + "\n", true);
	}

	async resolve_conflicts(event) {
		return this.modal.choose(
			"Destination contains existing files",
			`${event.count} conflict${event.count === 1 ? "" : "s"} found.`,
			[
				{ label: "Replace all", value: "replace", danger: true },
				{ label: "Skip existing", value: "skip", primary: true },
				{ label: "Cancel", value: "cancel" },
			]
		);
	}

	run_next() {
		if (this.active || !this.queue.length)
			return;
		const operation = this.active = this.queue.shift();
		operation.state = "running";
		const cmd = ["/usr/share/cockpit/navigator/scripts/paste.py3"];
		if (operation.type === "move") cmd.push("--move");
		cmd.push(operation.source_root, ...operation.sources, operation.destination);
		const proc = operation.proc = cockpit.spawn(cmd, { superuser: "try", err: "ignore" });
		let buffer = "";
		proc.stream(data => {
			buffer += data;
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines) this.handle_line(operation, line);
		});
		proc.done(() => this.finish(operation, true));
		proc.fail((error, data) => this.finish(operation, false, data || error?.message || "Transfer failed"));
	}

	async handle_line(operation, line) {
		if (!line.trim()) return;
		let event;
		try { event = JSON.parse(line); } catch { return; }
		if (event.event === "conflicts") {
			const policy = await this.resolve_conflicts(event);
			operation.proc?.input(JSON.stringify({ action: "conflicts", policy }) + "\n", true);
			return;
		}
		operation.last_event = event;
		this.update_card(operation, event);
	}

	finish(operation, succeeded, failure = "") {
		if (this.active !== operation) return;
		if (succeeded && operation.last_event?.event !== "cancelled") {
			this.update_card(operation, { event: "completed" });
			if (operation.type === "move" && operation.from_clipboard) {
				this.nav_window_ref.clip_board.length = 0;
				this.nav_window_ref.update_clipboard_button();
				this.nav_window_ref.context_menu.hide_paste();
			}
		} else if (!succeeded && !["cancelled", "error"].includes(operation.last_event?.event)) {
			this.update_card(operation, { event: "error", message: "Transfer failed", details: String(failure) });
		}
		this.refresh_tabs(operation);
		this.active = null;
		this.run_next();
	}

	refresh_tabs(operation) {
		const manager = this.nav_window_ref.tab_manager;
		const active = manager?.active_tab();
		if (active?.type !== "directory") return;
		const path = manager.current_path(active);
		if (path === operation.source_root || path === operation.destination)
			this.nav_window_ref.refresh();
	}
}
