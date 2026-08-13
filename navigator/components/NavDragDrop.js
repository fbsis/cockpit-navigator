/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 Josh Boudreau, Sam Silver, Dawson Della Valle
	Distributed under the GNU General Public License, version 3 or later.
*/

import { FileUpload } from "./FileUpload.js";
import { FileUploadManager } from "./FileUploadManager.js";

export class NavDragDrop {
	constructor(drop_area, nav_window_ref) {
		this.drop_areas = [drop_area, document.getElementById("nav-upload-dialog")];
		this.nav_window_ref = nav_window_ref;
		this.upload_manager = new FileUploadManager(nav_window_ref, 3);
		this.file_input = this.create_input(false);
		this.folder_input = this.create_input(true);
		this.install_dropzones();
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
			const files = [];
			for (let index = 0; index < input.files.length; index++) {
				const file = input.files.item(index);
				if (file) files.push({ file, relative_path: file.webkitRelativePath || file.name });
			}
			input.value = "";
			await this.enqueue_files(files, this.dialog_destination);
		};
		document.body.appendChild(input);
		return input;
	}

	install_dropzones() {
		if (!window.Dropzone) throw new Error("Dropzone is not available.");
		window.Dropzone.autoDiscover = false;
		this.dropzones = this.drop_areas.map(area => {
			const dropzone = new window.Dropzone(area, {
				url: "/",
				autoProcessQueue: false,
				maxFilesize: 10 * 1024,
				clickable: false,
				createImageThumbnails: false,
				previewsContainer: false,
				disablePreviews: true,
			});
			dropzone.on("dragenter", () => area.classList.add("drag-enter"));
			dropzone.on("dragover", () => area.classList.add("drag-enter"));
			dropzone.on("dragleave", event => {
				if (!area.contains(event.relatedTarget)) area.classList.remove("drag-enter");
			});
			dropzone.on("drop", () => {
				for (const target of this.drop_areas) target.classList.remove("drag-enter");
				dropzone.navigator_destination = this.nav_window_ref.pwd().path_str();
				this.upload_manager.show();
				this.upload_manager.set_preparing("Reading dropped items…");
			});
			dropzone.on("addedfiles", files => {
				const destination = dropzone.navigator_destination || this.nav_window_ref.pwd().path_str();
				const items = Array.from(files, file => ({
					file,
					relative_path: file.fullPath || file.webkitRelativePath || file.name,
				}));
				this.enqueue_files(items, destination).finally(() => dropzone.removeAllFiles(true));
			});
			dropzone.on("error", (_file, message) => {
				this.upload_manager.set_preparing("");
				this.nav_window_ref.modal_prompt.alert("Could not read dropped items.", String(message));
			});
			return dropzone;
		});
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

}
