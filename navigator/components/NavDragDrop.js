/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 Josh Boudreau, Sam Silver, Dawson Della Valle
	Distributed under the GNU General Public License, version 3 or later.
*/

import { FileUpload } from "./FileUpload.js";
import { FileUploadManager } from "./FileUploadManager.js";

export class NavDragDrop {
	constructor(drop_area, nav_window_ref) {
		for (const event of ["dragenter", "dragover", "dragleave", "drop"])
			drop_area.addEventListener(event, this, false);
		this.drop_area = drop_area;
		this.nav_window_ref = nav_window_ref;
		this.upload_manager = new FileUploadManager(nav_window_ref, 3);
		this.file_input = this.create_input(false);
		this.folder_input = this.create_input(true);
		document.getElementById("nav-upload-btn").addEventListener("click", () => this.upload_manager.show());
		document.getElementById("nav-upload-select-files").addEventListener("click", () => this.select_from_dialog(this.file_input));
		document.getElementById("nav-upload-select-folder").addEventListener("click", () => this.select_from_dialog(this.folder_input));
	}

	select_from_dialog(input) {
		this.dialog_destination = this.nav_window_ref.pwd().path_str();
		input.click();
	}

	create_input(folder) {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.hidden = true;
		if (folder) {
			input.webkitdirectory = true;
			input.setAttribute("webkitdirectory", "");
		}
		input.onchange = async () => {
			const files = [...input.files].map(file => ({
				file,
				relative_path: file.webkitRelativePath || file.name,
			}));
			input.value = "";
			await this.enqueue_files(files, this.dialog_destination);
		};
		document.body.appendChild(input);
		return input;
	}

	read_entries(reader) {
		return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
	}

	entry_file(entry) {
		return new Promise((resolve, reject) => entry.file(resolve, reject));
	}

	async scan_entry(entry, parent = "") {
		const relative_path = `${parent}${entry.name}`;
		if (entry.isFile) {
			try {
				return [{ file: await this.entry_file(entry), relative_path }];
			} catch (error) {
				return [this.failed_item(entry.name, relative_path, error)];
			}
		}
		if (!entry.isDirectory) return [];
		let children = [];
		try {
			const reader = entry.createReader();
			while (true) {
				const batch = await this.read_entries(reader);
				if (!batch.length) break;
				children.push(...batch);
			}
		} catch (error) {
			return [this.failed_item(entry.name, relative_path, error)];
		}
		const files = [];
		for (const child of children)
			files.push(...await this.scan_entry(child, `${relative_path}/`));
		return files;
	}

	failed_item(name, relative_path, error) {
		return {
			file: new File([], name),
			relative_path,
			error: error?.message || String(error || "Could not read dropped item."),
		};
	}

	async files_from_drop(data_transfer) {
		const files = [];
		for (const item of [...(data_transfer.items || [])]) {
			const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
			if (entry) {
				files.push(...await this.scan_entry(entry));
			} else {
				const file = item.getAsFile?.();
				if (file) files.push({ file, relative_path: file.name });
			}
		}
		if (!files.length) {
			for (const file of [...data_transfer.files])
				files.push({ file, relative_path: file.webkitRelativePath || file.name });
		}
		return this.deduplicate(files);
	}

	deduplicate(files) {
		const unique = new Map();
		for (const item of files) {
			const path = item.relative_path.replace(/^\/+/, "");
			if (!path || path.split("/").includes("..")) continue;
			const key = path;
			if (!unique.has(key)) unique.set(key, { ...item, relative_path: path });
		}
		return [...unique.values()];
	}

	async existing_paths(paths) {
		const process = cockpit.spawn(
			["/usr/share/cockpit/navigator/scripts/return-exists.py3", "--stdin-json"],
			{ err: "out", superuser: "try" },
		);
		process.input(JSON.stringify(paths));
		return JSON.parse(await process);
	}

	async resolve_conflicts(uploads) {
		const candidates = uploads.filter(upload => upload.state === "queued");
		const existence = candidates.length ? await this.existing_paths(candidates.map(upload => upload.path)) : {};
		const conflicts = candidates.filter(upload => existence[upload.path]);
		if (!conflicts.length) return uploads;
		const policy = await this.nav_window_ref.modal_prompt.choose(
			`${conflicts.length} upload conflict${conflicts.length === 1 ? "" : "s"}`,
			`${conflicts.length} destination item${conflicts.length === 1 ? " already exists" : "s already exist"}.`,
			[
				{ label: "Replace all", value: "replace", primary: true },
				{ label: "Skip existing", value: "skip" },
				{ label: "Cancel", value: "cancel", danger: true },
			],
		);
		if (policy === "cancel" || policy === null) return null;
		if (policy === "replace") {
			for (const upload of conflicts) upload.replace_existing = true;
		}
		if (policy === "skip") {
			for (const upload of conflicts) upload.state = "skipped";
		}
		return uploads;
	}

	async enqueue_files(items, destination = this.nav_window_ref.pwd().path_str()) {
		items = this.deduplicate(items);
		if (!items.length) {
			this.upload_manager.set_preparing("");
			return;
		}
		let uploads = items.map(item => {
			const upload = new FileUpload(item.file, destination, item.relative_path);
			if (item.error) {
				upload.state = "error";
				upload.error = item.error;
				upload.can_retry = false;
			}
			return upload;
		});
		try {
			this.upload_manager.set_preparing("Checking upload conflicts…");
			uploads = await this.resolve_conflicts(uploads);
			this.upload_manager.set_preparing("");
			if (uploads) this.upload_manager.add(uploads, destination);
		} catch (error) {
			this.upload_manager.set_preparing("");
			this.nav_window_ref.modal_prompt.alert("Could not prepare upload.", error.message || String(error));
		}
	}

	async handleEvent(event) {
		switch (event.type) {
			case "dragenter":
			case "dragover":
				event.preventDefault();
				event.stopPropagation();
				this.drop_area.classList.add("drag-enter");
				break;
			case "dragleave":
				event.preventDefault();
				event.stopPropagation();
				if (!this.drop_area.contains(event.relatedTarget)) this.drop_area.classList.remove("drag-enter");
				break;
			case "drop":
				event.preventDefault();
				event.stopPropagation();
				this.drop_area.classList.remove("drag-enter");
				this.upload_manager.show();
				this.upload_manager.set_preparing("Reading dropped items…");
				try {
					const destination = this.nav_window_ref.pwd().path_str();
					await this.enqueue_files(await this.files_from_drop(event.dataTransfer), destination);
				} catch (error) {
					this.upload_manager.set_preparing("");
					this.nav_window_ref.modal_prompt.alert("Could not read dropped items.", error.message || String(error));
				}
				break;
		}
	}
}
