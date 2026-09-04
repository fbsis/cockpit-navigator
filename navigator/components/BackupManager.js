export class BackupManager {
	constructor(nav_window_ref, config_store) {
		this.nav_window_ref = nav_window_ref;
		this.config_store = config_store;
		this.script = "/usr/share/cockpit/navigator/scripts/backup.py3";
	}

	async jobs() {
		const backups = await this.config_store.section("backups", { jobs: [] });
		if (!Array.isArray(backups.jobs)) backups.jobs = [];
		backups.jobs = backups.jobs.filter(job => job && typeof job.id === "string" && typeof job.source === "string" && (job.mode === "snapshot" || typeof job.destination === "string"));
		return backups.jobs;
	}

	directory_tabs() {
		return [...new Set((this.nav_window_ref.tab_manager?.tabs || [])
			.filter(tab => tab.type === "directory")
			.map(tab => this.nav_window_ref.tab_manager.current_path(tab)))];
	}

	escape(value) {
		const element = document.createElement("span");
		element.textContent = value ?? "";
		return element.innerHTML;
	}

	async run(action, ...arguments_) {
		const output = await cockpit.spawn([this.script, action, ...arguments_], { superuser: "try", err: "out" });
		const result = JSON.parse(output);
		if (!result.ok) throw new Error(result.error || "Backup operation failed.");
		return result;
	}

	async sync_systemd() {
		await this.run("sync-systemd");
	}

	async wait_for(operation, description) {
		let timeout;
		try {
			return await Promise.race([
				operation,
				new Promise((_, reject) => {
					timeout = window.setTimeout(() => reject(new Error(`${description} timed out after 15 seconds.`)), 15000);
				}),
			]);
		} finally {
			window.clearTimeout(timeout);
		}
	}

	open_modal(title) {
		const modal = this.nav_window_ref.modal_prompt;
		modal.set_header(title);
		modal.body.innerHTML = "";
		modal.footer.innerHTML = "";
		modal.show();
		return modal;
	}

	async show(notice = "", error = false) {
		const modal = this.open_modal("Backup schedules");
		const jobs = await this.jobs();
		const intro = document.createElement("p");
		intro.textContent = "Scheduled rsync copies and ZFS snapshots run as the current user.";
		if (notice) {
			const message = document.createElement("p");
			message.className = error ? "nav-backup-notice nav-backup-notice-error" : "nav-backup-notice";
			message.textContent = notice;
			modal.body.appendChild(message);
		}
		const add = document.createElement("button");
		add.type = "button";
		add.className = "pf-c-button pf-m-primary";
		add.textContent = "New schedule";
		add.onclick = () => this.wizard();
		modal.body.append(intro, add);
		if (!jobs.length) {
			const empty = document.createElement("p");
			empty.textContent = "No backup schedules yet.";
			modal.body.appendChild(empty);
		} else {
			const table = document.createElement("table");
			table.className = "nav-choice-table nav-backup-table";
			table.innerHTML = "<thead><tr><th>Name</th><th>Type</th><th>Schedule</th><th>Last run</th><th></th></tr></thead>";
			const body = document.createElement("tbody");
			for (const job of jobs) {
				const last = job.lastRun
					? `${job.lastRun.status === "success" ? "Success" : "Failed"}: ${new Date(job.lastRun.at).toLocaleString()}`
					: "Not run yet";
				const row = document.createElement("tr");
				row.innerHTML = `<td>${this.escape(job.name)}</td><td>${job.mode === "snapshot" ? "ZFS snapshot" : "rsync copy"}</td><td>${job.enabled ? this.escape(this.on_calendar(job)) : "Paused"}</td><td>${this.escape(last)}</td>`;
				const cell = document.createElement("td");
				cell.appendChild(this.action_menu(job));
				row.appendChild(cell);
				body.appendChild(row);
			}
			table.appendChild(body);
			modal.body.appendChild(table);
		}
		const close = document.createElement("button");
		close.type = "button";
		close.className = "pf-c-button pf-m-secondary";
		close.textContent = "Close";
		close.onclick = () => modal.hide();
		modal.footer.appendChild(close);
	}

	action_menu(job) {
		const holder = document.createElement("div");
		holder.className = "nav-backup-actions";
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = "pf-c-button pf-m-secondary";
		toggle.title = `Actions for ${job.name}`;
		toggle.setAttribute("aria-label", `Actions for ${job.name}`);
		toggle.setAttribute("aria-expanded", "false");
		toggle.innerHTML = '<i class="fas fa-bars"></i>';
		const menu = document.createElement("div");
		menu.className = "nav-backup-action-menu";
		const actions = [
			["Open", "pf-m-secondary", () => this.wizard(job)],
			["Run now", "pf-m-primary", () => this.run_now(job)],
			["Logs", "pf-m-secondary", () => this.show_logs(job)],
			["Delete", "pf-m-danger", () => this.remove(job)],
		];
		for (const [label, style, handler] of actions) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = `pf-c-button ${style}`;
			button.textContent = label;
			button.onclick = handler;
			menu.appendChild(button);
		}
		toggle.onclick = event => {
			event.stopPropagation();
			const open = menu.classList.toggle("nav-backup-action-menu-open");
			toggle.setAttribute("aria-expanded", String(open));
		};
		holder.addEventListener("click", event => event.stopPropagation());
		document.addEventListener("click", () => {
			menu.classList.remove("nav-backup-action-menu-open");
			toggle.setAttribute("aria-expanded", "false");
		}, { once: true });
		holder.append(toggle, menu);
		return holder;
	}

	async run_now(job) {
		this.nav_window_ref.start_load();
		try {
			await this.run("start", job.id);
			await this.show(`Started ${job.name}. The service status will update after it finishes.`);
		} catch (error) {
			await this.show(`Could not run ${job.name}: ${error.message || String(error)}`, true);
		} finally {
			this.nav_window_ref.stop_load();
		}
	}

	async show_logs(job) {
		const modal = this.open_modal(`Logs: ${job.name}`);
		const result = await this.run("logs", job.id).catch(error => ({ lines: [`Could not load logs: ${error.message || String(error)}`], journal: [] }));
		for (const [title, lines] of [["rsync job log", result.lines], ["systemd service journal", result.journal]]) {
			const heading = document.createElement("h3");
			heading.textContent = title;
			const log = document.createElement("pre");
			log.className = "nav-backup-log";
			log.textContent = lines.join("\n") || "No entries yet.";
			modal.body.append(heading, log);
		}
		const close = document.createElement("button");
		close.type = "button";
		close.className = "pf-c-button pf-m-secondary";
		close.textContent = "Close";
		close.onclick = () => this.show();
		modal.footer.appendChild(close);
	}

	async remove(job) {
		const confirmed = await this.nav_window_ref.modal_prompt.confirm(
			`Delete ${job.name}?`,
			"The schedule, timer, service, and Navigator job log will be removed.",
			true,
		);
		if (!confirmed) return this.show();
		try {
			const backups = await this.config_store.section("backups", { jobs: [] });
			backups.jobs = (Array.isArray(backups.jobs) ? backups.jobs : []).filter(item => item?.id !== job.id);
			await this.wait_for(this.config_store.save(), "Saving Navigator settings");
			await this.wait_for(this.sync_systemd(), "Updating systemd timers");
			await this.show(`Deleted ${job.name}.`);
		} catch (error) {
			await this.show(`Could not delete ${job.name}: ${error.message || String(error)}`, true);
		}
	}

	on_calendar(job) {
		return job.onCalendar || { "0 */2 * * *": "*-*-* 00/2:00:00", "0 */6 * * *": "*-*-* 00/6:00:00", "0 2 * * *": "*-*-* 02:00:00" }[job.schedule] || "*-*-* 02:00:00";
	}

	schedule_kind(calendar) {
		return { "*-*-* 00/2:00:00": "every-2", "*-*-* 00/6:00:00": "every-6", "*-*-* 02:00:00": "daily" }[calendar] || "custom";
	}

	async wizard(job = null) {
		const paths = [this.nav_window_ref.pwd().path_str(), ...this.directory_tabs()];
		const draft = {
			id: job?.id || crypto.randomUUID(), name: job?.name || "Backup", mode: job?.mode || "rsync",
			source: job?.source || paths[0], destination: job?.destination || paths[1] || "/backup",
			enabled: job?.enabled ?? true, onCalendar: this.on_calendar(job || {}),
			scheduleKind: this.schedule_kind(this.on_calendar(job || {})),
			snapshotSource: job?.snapshotSource || false, snapshotDestination: job?.snapshotDestination || false,
			snapshotRetention: Number(job?.snapshotRetention ?? 14), lastRun: job?.lastRun || null,
		};
		let step = 0;
		const modal = this.open_modal(job ? `Edit schedule: ${job.name}` : "New backup schedule");
		const render = async () => {
			modal.body.innerHTML = "";
			modal.footer.innerHTML = "";
			const progress = document.createElement("p");
			progress.className = "nav-backup-progress";
			progress.textContent = `Step ${step + 1} of 4`;
			modal.body.appendChild(progress);
			if (step === 0) this.render_paths(modal.body, draft, paths);
			else if (step === 1) this.render_schedule(modal.body, draft);
			else if (step === 2) await this.render_snapshots(modal.body, draft);
			else await this.render_summary(modal.body, draft);
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "pf-c-button pf-m-secondary";
			cancel.textContent = "Cancel";
			cancel.onclick = () => modal.hide();
			modal.footer.appendChild(cancel);
			if (step) {
				const back = document.createElement("button");
				back.type = "button";
				back.className = "pf-c-button pf-m-secondary";
				back.textContent = "Back";
				back.onclick = () => { this.read_step(modal.body, draft, step); step--; render(); };
				modal.footer.appendChild(back);
			}
			const next = document.createElement("button");
			next.type = "button";
			next.className = "pf-c-button pf-m-primary";
			next.textContent = step === 3 ? "Save schedule" : "Next";
			next.onclick = async () => {
				if (!this.read_step(modal.body, draft, step)) return;
				if (step < 3) { step++; await render(); }
				else {
					next.disabled = true;
					next.textContent = "Saving...";
					await this.save(draft);
				}
			};
			modal.footer.appendChild(next);
		};
		await render();
	}

	input(label, value, name, options = []) {
		const row = document.createElement("label");
		row.className = "nav-backup-field";
		row.textContent = label;
		const input = document.createElement("input");
		input.name = name;
		input.type = "text";
		input.value = value;
		if (options.length) {
			const list = document.createElement("datalist");
			list.id = `backup-${name}`;
			list.innerHTML = options.map(option => `<option value="${this.escape(option)}"></option>`).join("");
			input.setAttribute("list", list.id);
			row.append(input, list);
		} else row.appendChild(input);
		return row;
	}

	render_paths(body, draft, paths) {
		body.append(this.input("Name", draft.name, "name"), this.input("Source", draft.source, "source", paths));
		const mode = document.createElement("label");
		mode.className = "nav-backup-field";
		mode.textContent = "Type";
		mode.innerHTML += `<select name="mode"><option value="rsync">rsync copy</option><option value="snapshot">ZFS snapshot only</option></select>`;
		mode.querySelector("select").value = draft.mode;
		body.appendChild(mode);
		if (draft.mode === "rsync") body.appendChild(this.input("Destination", draft.destination, "destination", paths));
	}

	render_schedule(body, draft) {
		const kind = document.createElement("label");
		kind.className = "nav-backup-field";
		kind.innerHTML = "Frequency<select name=\"scheduleKind\"><option value=\"every-2\">Every 2 hours</option><option value=\"every-6\">Every 6 hours</option><option value=\"daily\">Every day at 02:00</option><option value=\"custom\">Custom systemd calendar</option></select>";
		kind.querySelector("select").value = draft.scheduleKind;
		body.appendChild(kind);
		body.appendChild(this.input("Systemd OnCalendar", draft.onCalendar, "onCalendar"));
		const enabled = document.createElement("label");
		enabled.className = "nav-backup-checkbox";
		enabled.innerHTML = `<input type="checkbox" name="enabled" ${draft.enabled ? "checked" : ""}> Run automatically`;
		body.appendChild(enabled);
	}

	async render_snapshots(body, draft) {
		const source = await this.nav_window_ref.zfs_snapshot_manager.detect(draft.source).catch(() => ({ supported: false }));
		const destination = draft.mode === "rsync"
			? await this.nav_window_ref.zfs_snapshot_manager.detect(draft.destination).catch(() => ({ supported: false }))
			: { supported: false };
		if (draft.mode === "snapshot" && !source.supported) body.appendChild(document.createTextNode("The selected source is not on ZFS. Choose a ZFS source before saving."));
		for (const [name, label, info, forced] of [
			["snapshotSource", "Snapshot source", source, draft.mode === "snapshot"],
			["snapshotDestination", "Snapshot destination", destination, false],
		]) {
			const field = document.createElement("label");
			field.className = "nav-backup-checkbox";
			field.innerHTML = `<input type="checkbox" name="${name}" ${draft[name] || forced ? "checked" : ""} ${info.supported ? "" : "disabled"}> ${label}${info.supported ? ` (${this.escape(info.dataset)})` : " (not on ZFS)"}`;
			body.appendChild(field);
		}
		const retention = document.createElement("label");
		retention.className = "nav-backup-field";
		retention.innerHTML = `Keep latest snapshots (0 keeps all)<input type="number" min="0" step="1" name="snapshotRetention" value="${draft.snapshotRetention}">`;
		body.appendChild(retention);
	}

	async render_summary(body, draft) {
		const type = draft.mode === "snapshot" ? "ZFS snapshot" : "rsync copy";
		body.innerHTML += `<h3>Summary</h3><dl class="nav-backup-summary"><dt>Type</dt><dd>${type}</dd><dt>Source</dt><dd>${this.escape(draft.source)}</dd>${draft.mode === "rsync" ? `<dt>Destination</dt><dd>${this.escape(draft.destination)}</dd>` : ""}<dt>Schedule</dt><dd>${draft.enabled ? this.escape(draft.onCalendar) : "Paused"}</dd><dt>Snapshot retention</dt><dd>${draft.snapshotRetention || "Unlimited"}</dd></dl>`;
		if (draft.lastRun) {
			const run = draft.lastRun;
			body.innerHTML += `<h3>Latest execution</h3><dl class="nav-backup-summary"><dt>Status</dt><dd>${this.escape(run.status)}</dd><dt>Started</dt><dd>${this.escape(new Date(run.at).toLocaleString())}</dd><dt>Duration</dt><dd>${run.durationSeconds ?? "-"} seconds</dd><dt>Files</dt><dd>${this.escape(run.metrics?.files || "-")}</dd><dt>Transferred</dt><dd>${this.escape(run.metrics?.transferred || "-")}</dd><dt>Snapshots kept</dt><dd>${run.metrics?.snapshots ?? "-"}</dd></dl>`;
		}
		const logs = await this.run("logs", draft.id).catch(() => ({ lines: [], journal: [] }));
		for (const [title, lines] of [["rsync job log", logs.lines], ["systemd service journal", logs.journal]]) {
			const heading = document.createElement("h3");
			heading.textContent = title;
			const log = document.createElement("pre");
			log.className = "nav-backup-log";
			log.textContent = lines.join("\n") || "No entries yet.";
			body.append(heading, log);
		}
	}

	read_step(body, draft, step) {
		const get = name => body.querySelector(`[name="${name}"]`);
		if (step === 0) {
			draft.name = get("name").value.trim();
			draft.source = get("source").value.trim();
			draft.mode = get("mode").value;
			draft.destination = draft.mode === "rsync" ? get("destination")?.value.trim() : null;
			if (!draft.name || !draft.source.startsWith("/") || (draft.mode === "rsync" && (!draft.destination?.startsWith("/") || draft.source === draft.destination))) {
				this.nav_window_ref.modal_prompt.alert("Invalid paths", "Enter a name and different absolute paths.");
				return false;
			}
		} else if (step === 1) {
			draft.scheduleKind = get("scheduleKind").value;
			const presets = { "every-2": "*-*-* 00/2:00:00", "every-6": "*-*-* 00/6:00:00", daily: "*-*-* 02:00:00" };
			draft.onCalendar = presets[draft.scheduleKind] || get("onCalendar").value.trim();
			draft.enabled = get("enabled").checked;
			if (draft.enabled && (!draft.onCalendar || /[\r\n]/.test(draft.onCalendar))) {
				this.nav_window_ref.modal_prompt.alert("Invalid schedule", "Enter a single-line systemd OnCalendar expression.");
				return false;
			}
		} else if (step === 2) {
			draft.snapshotSource = get("snapshotSource").checked;
			draft.snapshotDestination = get("snapshotDestination").checked;
			draft.snapshotRetention = Math.max(0, Number.parseInt(get("snapshotRetention").value, 10) || 0);
		}
		return true;
	}

	async save(draft) {
		try {
			if (draft.mode === "snapshot" && !draft.snapshotSource)
				throw new Error("The source must be on ZFS for a snapshot-only job.");
			const jobs = await this.jobs();
			const index = jobs.findIndex(job => job.id === draft.id);
			if (index === -1) jobs.push(draft);
			else jobs[index] = draft;
			await this.wait_for(this.config_store.save(), "Saving Navigator settings");
		} catch (error) {
			await this.show(`Could not save schedule: ${error.message || String(error)}`, true);
			return;
		}
		try {
			await this.wait_for(this.sync_systemd(), "Updating systemd timers");
			this.nav_window_ref.modal_prompt.hide();
		} catch (error) {
			await this.show(`Schedule saved, but systemd timers were not updated: ${error.message || String(error)}`, true);
		}
	}
}
