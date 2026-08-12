/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 45Drives

	This file is part of Cockpit Navigator.
*/

import { simple_spawn } from "../functions.js";

export class TabManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.nav_window_ref.tab_manager = this;
		this.tab_list = document.getElementById("nav-tab-list");
		this.new_tab_button = document.getElementById("nav-new-tab-btn");
		this.editor = document.getElementById("nav-edit-contents-view");
		this.editor_header = document.getElementById("nav-edit-contents-header");
		this.textarea = document.getElementById("nav-edit-contents-textarea");
		this.file_view = document.getElementById("nav-contents-view-holder");
		this.tabs = [];
		this.next_id = 1;
		this.active_tab_id = null;

		this.new_tab_button.addEventListener("click", () => this.create_directory_tab());
		document.getElementById("nav-continue-edit-contents-btn").onclick = () => this.save_active_file();
		document.getElementById("nav-cancel-edit-contents-btn").onclick = () => this.close_tab(this.active_tab_id);
		this.textarea.addEventListener("input", () => this.update_active_buffer());
		window.addEventListener("keydown", event => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && this.active_tab()?.type === "file") {
				event.preventDefault();
				this.save_active_file();
			}
		});

		this.nav_window_ref.navigation_change_handler = () => {
			this.sync_active_directory();
			this.render();
		};

		const initial_tab = this.directory_tab_from_window();
		this.tabs.push(initial_tab);
		this.active_tab_id = initial_tab.id;
		this.rendered_directory_tab_id = initial_tab.id;
		this.render();
	}

	active_tab() {
		return this.tabs.find(tab => tab.id === this.active_tab_id);
	}

	directory_tab_from_window() {
		return {
			id: this.next_id++,
			type: "directory",
			path_stack: this.nav_window_ref.path_stack,
			path_stack_index: this.nav_window_ref.path_stack_index,
		};
	}

	sync_active_directory() {
		const tab = this.active_tab();
		if (tab?.type !== "directory")
			return;
		tab.path_stack = this.nav_window_ref.path_stack;
		tab.path_stack_index = this.nav_window_ref.path_stack_index;
	}

	update_active_buffer() {
		const tab = this.active_tab();
		if (tab?.type !== "file")
			return;
		tab.contents = this.textarea.value;
		tab.modified = tab.contents !== tab.original_contents;
		this.render();
	}

	current_path(tab) {
		return tab.type === "file"
			? tab.path
			: tab.path_stack[tab.path_stack_index].path_str();
	}

	create_directory_tab() {
		this.update_active_buffer();
		this.sync_active_directory();
		const source_path = this.active_tab()?.type === "directory"
			? this.nav_window_ref.pwd().path_str()
			: this.active_tab().parent_path;
		const path_stack = this.nav_window_ref.build_path_stack(source_path || "/");
		const tab = {
			id: this.next_id++,
			type: "directory",
			path_stack,
			path_stack_index: path_stack.length - 1,
		};
		this.tabs.push(tab);
		this.activate_tab(tab.id);
	}

	async open_file(path, display_path = path) {
		const existing_tab = this.tabs.find(tab => tab.type === "file" && tab.path === path);
		if (existing_tab) {
			this.activate_tab(existing_tab.id);
			return;
		}

		let contents;
		try {
			contents = await cockpit.file(path, { superuser: "try" }).read();
		} catch (error) {
			this.nav_window_ref.modal_prompt.alert("Could not open file.", error.message || String(error));
			return;
		}

		const parent_path = display_path.substring(0, display_path.lastIndexOf("/")) || "/";
		const tab = {
			id: this.next_id++,
			type: "file",
			path,
			display_path,
			parent_path,
			contents,
			original_contents: contents,
			modified: false,
		};
		this.tabs.push(tab);
		this.activate_tab(tab.id);
	}

	activate_tab(tab_id) {
		if (tab_id === this.active_tab_id)
			return;

		this.update_active_buffer();
		this.sync_active_directory();
		const tab = this.tabs.find(candidate => candidate.id === tab_id);
		if (!tab)
			return;

		this.active_tab_id = tab.id;
		this.render();
		if (tab.type === "directory") {
			this.activate_directory_view(tab);
		} else {
			this.show_file(tab);
		}
	}

	activate_directory_view(tab) {
		this.show_directory(tab);
		if (this.rendered_directory_tab_id !== tab.id) {
			this.rendered_directory_tab_id = tab.id;
			this.nav_window_ref.refresh();
		}
	}

	show_directory(tab) {
		this.editor.style.display = "none";
		this.file_view.style.display = "flex";
		this.nav_window_ref.path_stack = tab.path_stack;
		this.nav_window_ref.path_stack_index = tab.path_stack_index;
		this.set_directory_controls_disabled(false);
	}

	show_file(tab) {
		this.file_view.style.display = "none";
		this.editor.style.display = "flex";
		this.set_directory_controls_disabled(true);
		this.editor_header.textContent = `Editing ${tab.display_path}`;
		this.textarea.value = tab.contents;
		this.textarea.focus();
	}

	set_directory_controls_disabled(disabled) {
		for (const control of document.querySelectorAll(".nav-header button, .nav-header input")) {
			control.disabled = disabled || Boolean(control.keep_disabled);
		}
		if (!disabled)
			this.nav_window_ref.set_nav_button_state();
	}

	async save_active_file() {
		const tab = this.active_tab();
		if (tab?.type !== "file")
			return;
		this.update_active_buffer();
		try {
			await simple_spawn(["/usr/share/cockpit/navigator/scripts/write-to-file.py3", tab.path], tab.contents);
			tab.original_contents = tab.contents;
			tab.modified = false;
			this.render();
		} catch (error) {
			this.nav_window_ref.modal_prompt.alert("Could not save file.", error.message || String(error));
		}
	}

	async close_tab(tab_id) {
		if (this.tabs.length === 1)
			return;

		const closing_index = this.tabs.findIndex(tab => tab.id === tab_id);
		if (closing_index === -1)
			return;
		const closing_tab = this.tabs[closing_index];
		if (closing_tab.id === this.active_tab_id && closing_tab.type === "file")
			this.update_active_buffer();
		if (closing_tab.type === "file" && closing_tab.modified) {
			const discard = await this.nav_window_ref.modal_prompt.confirm(
				`Close ${closing_tab.display_path}?`,
				"Unsaved changes will be discarded.",
				true
			);
			if (!discard)
				return;
		}

		const was_active = this.active_tab_id === tab_id;
		this.tabs.splice(closing_index, 1);
		if (was_active) {
			const next_tab = this.tabs[Math.min(closing_index, this.tabs.length - 1)];
			this.active_tab_id = next_tab.id;
			if (next_tab.type === "directory") {
				this.activate_directory_view(next_tab);
			} else {
				this.show_file(next_tab);
			}
		}
		this.render();
	}

	render() {
		this.tab_list.replaceChildren();
		for (const tab of this.tabs) {
			const path = this.current_path(tab);
			const tab_element = document.createElement("div");
			tab_element.className = "nav-tab";
			if (tab.id === this.active_tab_id)
				tab_element.classList.add("nav-tab-active");
			tab_element.title = path;

			const tab_button = document.createElement("button");
			tab_button.type = "button";
			tab_button.className = "nav-tab-path disable-while-loading";
			tab_button.setAttribute("role", "tab");
			tab_button.setAttribute("aria-selected", String(tab.id === this.active_tab_id));
			tab_button.innerHTML = tab.type === "file" ? '<i class="fas fa-file-alt"></i>' : '<i class="fas fa-folder"></i>';
			const label = document.createElement("span");
			label.textContent = path === "/" ? "/" : path.split("/").filter(Boolean).pop();
			tab_button.appendChild(label);
			if (tab.modified) {
				const modified = document.createElement("span");
				modified.className = "nav-tab-modified";
				modified.title = "Unsaved changes";
				modified.textContent = "●";
				tab_button.appendChild(modified);
			}
			tab_button.addEventListener("click", () => this.activate_tab(tab.id));

			const close_button = document.createElement("button");
			close_button.type = "button";
			close_button.className = "nav-tab-close disable-while-loading";
			close_button.title = `Close ${path}`;
			close_button.setAttribute("aria-label", `Close ${path}`);
			close_button.innerHTML = '<i class="fas fa-times"></i>';
			close_button.disabled = this.tabs.length === 1;
			close_button.keep_disabled = this.tabs.length === 1;
			if (this.tabs.length === 1)
				close_button.classList.add("nav-tab-close-hidden");
			close_button.addEventListener("click", () => this.close_tab(tab.id));

			tab_element.append(tab_button, close_button);
			this.tab_list.appendChild(tab_element);
		}
	}
}
