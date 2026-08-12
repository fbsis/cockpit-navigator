export class ZfsSnapshotManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.path_cache = new Map();
		this.pending = new Map();
		this.script = "/usr/share/cockpit/navigator/scripts/zfs-snapshots.py3";
	}

	cached(path) {
		return this.path_cache.get(path) || null;
	}

	async detect(path) {
		const cached = this.cached(path);
		if (cached) return cached;
		if (this.pending.has(path)) return this.pending.get(path);
		const request = this.run("detect", path).then(result => {
			this.path_cache.set(path, result);
			return result;
		}).finally(() => this.pending.delete(path));
		this.pending.set(path, request);
		return request;
	}

	async supported(path) {
		try {
			const result = await this.detect(path);
			return result.supported === true && path !== result.mountpoint;
		} catch (error) {
			console.warn("Could not detect ZFS filesystem.", error);
			return false;
		}
	}

	async run(action, ...arguments_) {
		const output = await cockpit.spawn(
			[this.script, action, ...arguments_],
			{ superuser: "try", err: "out" },
		);
		const result = JSON.parse(output);
		if (!result.ok) throw new Error(result.error || "ZFS snapshot operation failed.");
		return result;
	}

	async show_history(entry) {
		const path = entry.path_str();
		this.nav_window_ref.start_load();
		let result;
		try {
			result = await this.run("list", path);
		} catch (error) {
			await this.nav_window_ref.modal_prompt.alert("Could not read snapshot history.", error.message || String(error));
			return;
		} finally {
			this.nav_window_ref.stop_load();
		}
		if (!result.snapshots.length) {
			await this.nav_window_ref.modal_prompt.alert("No snapshot history", "No ZFS snapshot contains this file or folder.");
			return;
		}
		const response = await this.nav_window_ref.modal_prompt.prompt("ZFS snapshot history", {
			snapshot: {
				label: `${path} (${result.dataset})`,
				type: "select",
				options: [...result.snapshots].reverse().map(snapshot => ({
					value: snapshot.name,
					label: `${snapshot.createdText} — ${snapshot.shortName}`,
				})),
			},
		});
		if (!response) return;
		const selected = result.snapshots.find(snapshot => snapshot.name === response.snapshot);
		if (!selected) return;
		const confirmed = await this.nav_window_ref.modal_prompt.confirm(
			`Restore ${entry.filename} from ${selected.shortName}?`,
			selected.type === "directory"
				? "The snapshot folder will be merged into the current folder. Existing replaced files are preserved in a hidden backup directory; current files absent from the snapshot are kept."
				: "The current file will be preserved beside it as a hidden backup before this version is restored.",
			true,
		);
		if (!confirmed) return;
		this.nav_window_ref.start_load();
		try {
			const restored = await this.run("restore", path, selected.name);
			await this.nav_window_ref.refresh();
			await this.nav_window_ref.modal_prompt.alert(
				"Snapshot restored",
				restored.backup ? `Previous content was preserved at ${restored.backup}.` : "The selected snapshot version was restored.",
			);
		} catch (error) {
			await this.nav_window_ref.modal_prompt.alert("Could not restore snapshot.", error.message || String(error));
		} finally {
			this.nav_window_ref.stop_load();
		}
	}
}
