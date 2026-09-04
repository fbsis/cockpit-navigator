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
		return (this.nav_window_ref.tab_manager?.tabs || [])
			.filter(tab => tab.type === "directory")
			.map(tab => this.nav_window_ref.tab_manager.current_path(tab));
	}

	async run(action, ...arguments_) {
		const output = await cockpit.spawn([this.script, action, ...arguments_], { superuser: "try", err: "out" });
		const result = JSON.parse(output);
		if (!result.ok) throw new Error(result.error || "Backup operation failed.");
		return result;
	}

	async sync_cron() {
		await this.run("sync-cron");
	}

	async show() {
		const jobs = await this.jobs();
		const choices = [{ label: "New backup", value: "new", primary: true }];
		for (const job of jobs) {
			const status = job.lastRun?.status === "success" ? "last run succeeded" : job.lastRun?.status === "error" ? "last run failed" : "not run yet";
			choices.push({ label: `${job.name} - ${job.enabled ? job.schedule : "paused"} (${status})`, value: job.id });
		}
		const selected = await this.nav_window_ref.modal_prompt.choose_list("Backups", "Create, run, or remove a backup job.", choices);
		if (!selected) return;
		if (selected === "new") return this.create();
		const job = jobs.find(item => item.id === selected);
		if (job) await this.manage(job);
	}

	async create() {
		const paths = [...new Set([this.nav_window_ref.pwd().path_str(), ...this.directory_tabs()])];
		const mode = await this.nav_window_ref.modal_prompt.choose("New backup", "Choose how this job protects the current data.", [
			{ label: "Copy with rsync", value: "rsync", primary: true },
			{ label: "ZFS snapshot only", value: "snapshot" },
		]);
		if (!mode) return;
		const fields = {
			name: { label: "Name:", type: "text", default: "Backup" },
			source: { label: "Source:", type: "text", default: paths[0], options: paths },
			schedule: { label: "Cron schedule:", type: "text", default: "0 2 * * *" },
			enabled: { label: "Run automatically", type: "checkbox", default: true },
		};
		if (mode === "rsync") fields.destination = { label: "Destination:", type: "text", default: paths[1] || "/backup", options: paths };
		const response = await this.nav_window_ref.modal_prompt.prompt(mode === "rsync" ? "New rsync backup" : "New ZFS snapshot", fields);
		if (!response) return;
		const name = response.name.trim();
		const source = response.source.trim();
		const destination = response.destination?.trim() || null;
		if (!name || !source.startsWith("/") || (mode === "rsync" && (!destination.startsWith("/") || source === destination))) {
			await this.nav_window_ref.modal_prompt.alert("Invalid backup", "Enter a name and different absolute source and destination paths.");
			return;
		}
		if (response.enabled && !/^[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+$/.test(response.schedule.trim())) {
			await this.nav_window_ref.modal_prompt.alert("Invalid schedule", "Enter a five-field cron expression, for example: 0 2 * * *.");
			return;
		}
		const sourceZfs = await this.nav_window_ref.zfs_snapshot_manager.detect(source).catch(() => ({ supported: false }));
		if (mode === "snapshot" && !sourceZfs.supported) {
			await this.nav_window_ref.modal_prompt.alert("Snapshot unavailable", "The selected source is not on a ZFS dataset.");
			return;
		}
		const destinationZfs = destination
			? await this.nav_window_ref.zfs_snapshot_manager.detect(destination).catch(() => ({ supported: false }))
			: { supported: false };
		if (mode === "snapshot") {
			const jobs = await this.jobs();
			jobs.push({
				id: crypto.randomUUID(), name, mode, source, schedule: response.schedule.trim(), enabled: response.enabled,
				snapshotSource: true, snapshotDestination: false,
			});
			await this.config_store.save();
			try {
				await this.sync_cron();
				await this.nav_window_ref.modal_prompt.alert("Snapshot job saved", `Snapshots will be created for ${sourceZfs.dataset}.`);
			} catch (error) {
				await this.nav_window_ref.modal_prompt.alert("Could not schedule snapshot", error.message || String(error));
			}
			return;
		}
		const snapshots = await this.nav_window_ref.modal_prompt.prompt("ZFS snapshots", {
			source: { label: sourceZfs.supported ? `Snapshot source (${sourceZfs.dataset})` : "Source is not on ZFS", type: "checkbox", default: false },
			destination: { label: destinationZfs.supported ? `Snapshot destination (${destinationZfs.dataset})` : "Destination is not on ZFS", type: "checkbox", default: false },
		});
		if (!snapshots) return;
		const jobs = await this.jobs();
		jobs.push({
			id: crypto.randomUUID(), name, mode, source, destination, schedule: response.schedule.trim(), enabled: response.enabled,
			snapshotSource: sourceZfs.supported && snapshots.source,
			snapshotDestination: destinationZfs.supported && snapshots.destination,
		});
		await this.config_store.save();
		try {
			await this.sync_cron();
			await this.nav_window_ref.modal_prompt.alert("Backup saved", "The destination will be created automatically when this backup runs.");
		} catch (error) {
			await this.nav_window_ref.modal_prompt.alert("Could not schedule backup", error.message || String(error));
		}
	}

	async manage(job) {
		const description = job.mode === "snapshot" ? `Snapshot of ${job.source}` : `${job.source} to ${job.destination}`;
		const action = await this.nav_window_ref.modal_prompt.choose("Backup: " + job.name, description, [
			{ label: "Run now", value: "run", primary: true },
			{ label: job.enabled ? "Pause schedule" : "Enable schedule", value: "toggle" },
			{ label: "Remove backup", value: "remove", danger: true },
		]);
		if (action === "run") {
			this.nav_window_ref.start_load();
			try {
				const result = await this.run("run", job.id);
				const completed = job.mode === "snapshot" ? `Created a snapshot for ${job.source}.` : `Copied ${job.source} to ${job.destination}.`;
				await this.nav_window_ref.modal_prompt.alert("Backup complete", result.skipped ? result.message : completed);
			} catch (error) {
				await this.nav_window_ref.modal_prompt.alert("Backup failed", error.message || String(error));
			} finally {
				this.nav_window_ref.stop_load();
			}
		} else if (action === "toggle") {
			job.enabled = !job.enabled;
			await this.config_store.save();
			await this.sync_cron();
		} else if (action === "remove") {
			const jobs = await this.jobs();
			const backups = await this.config_store.section("backups", { jobs: [] });
			backups.jobs = jobs.filter(item => item.id !== job.id);
			await this.config_store.save();
			await this.sync_cron();
		}
	}
}
