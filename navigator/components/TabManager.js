/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 45Drives

	This file is part of Cockpit Navigator.
*/

import { simple_spawn } from "../functions.js";
import { CodeEditor } from "./CodeEditor.js";
import { TerminalManager } from "./TerminalManager.js";

export class TabManager {
	constructor(nav_window_ref, config_store) {
		this.nav_window_ref = nav_window_ref;
		this.config_store = config_store;
		this.nav_window_ref.tab_manager = this;
		this.tab_list = document.getElementById("nav-tab-list");
		this.new_tab_button = document.getElementById("nav-new-tab-btn");
		this.editor = document.getElementById("nav-edit-contents-view");
		this.editor_header = document.getElementById("nav-edit-contents-header");
		this.file_view = document.getElementById("nav-contents-view-holder");
		this.terminal_view = document.getElementById("nav-terminal-view");
		this.tabs = [];
		this.next_id = 1;
		this.active_tab_id = null;
		this.restoring_workspace = true;
		this.workspace_save_timer = null;
		this.workspace_save_error_shown = false;

		this.new_tab_button.addEventListener("click", () => this.create_directory_tab());
		document.getElementById("nav-continue-edit-contents-btn").onclick = () => this.save_active_file();
		document.getElementById("nav-cancel-edit-contents-btn").onclick = () => this.close_tab(this.active_tab_id);
		this.code_editor = new CodeEditor(config_store, {
			onChange: (path, modified) => this.on_editor_change(path, modified),
			onError: (title, error) => this.nav_window_ref.modal_prompt.alert(title, error.message || String(error)),
		});
		this.terminal_manager = new TerminalManager(nav_window_ref, config_store);
		this.ready = this.initialize_workspace();
		window.addEventListener("keydown", event => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && this.active_tab()?.type === "file") {
				event.preventDefault();
				this.save_active_file();
			}
		});

		this.nav_window_ref.navigation_change_handler = () => {
			this.sync_active_directory();
			this.render();
			this.persist_workspace();
		};

		const initial_tab = this.directory_tab_from_window();
		this.tabs.push(initial_tab);
		this.active_tab_id = initial_tab.id;
		this.rendered_directory_tab_id = initial_tab.id;
		this.render();
	}

	async initialize_workspace() {
		await this.code_editor.ready;
		try {
			const user = await cockpit.user();
			this.workspace_storage_key = `navigator-workspace:${user.name || user.user || "unknown"}`;
		} catch (error) {
			this.workspace_storage_key = "navigator-workspace:unknown";
		}
		this.workspace = await this.config_store.section("workspace", { tabs: [], activeIndex: 0 });
		let saved = this.workspace;
		try {
			const local = JSON.parse(localStorage.getItem(this.workspace_storage_key) || "null");
			if (local && Array.isArray(local.tabs) && Number(local.updatedAt) >= Number(saved.updatedAt || 0))
				saved = local;
		} catch (error) {
			console.warn("Could not read local workspace snapshot.", error);
		}
		await this.restore_workspace(saved);
		this.restoring_workspace = false;
		this.persist_workspace();
	}

	async restore_workspace(saved) {
		if (!Array.isArray(saved?.tabs) || !saved.tabs.length)
			return;
		const restored_tabs = [];
		const restored_by_index = new Map();
		const restored_file_paths = new Set();
		const failures = [];
		for (const [index, descriptor] of saved.tabs.entries()) {
			if (!descriptor || typeof descriptor.path !== "string" || !descriptor.path.startsWith("/"))
				continue;
			if (descriptor.type === "directory") {
				const path_stack = this.nav_window_ref.build_path_stack(descriptor.path);
				const tab = {
					id: this.next_id++, type: "directory", path_stack,
					path_stack_index: path_stack.length - 1,
				};
				restored_tabs.push(tab);
				restored_by_index.set(index, tab);
			} else if (descriptor.type === "file") {
				if (restored_file_paths.has(descriptor.path))
					continue;
				try {
					const contents = await cockpit.file(descriptor.path, { superuser: "try" }).read();
					if (contents === null) throw new Error("File no longer exists");
					const display_path = typeof descriptor.displayPath === "string" ? descriptor.displayPath : descriptor.path;
					const tab = {
						id: this.next_id++, type: "file", path: descriptor.path, display_path,
						parent_path: display_path.substring(0, display_path.lastIndexOf("/")) || "/",
						modified: false,
					};
					this.code_editor.create_session(tab.path, contents, tab.display_path);
					restored_file_paths.add(tab.path);
					restored_tabs.push(tab);
					restored_by_index.set(index, tab);
				} catch (error) {
					failures.push(`${descriptor.path}: ${error.message || String(error)}`);
				}
			}
		}
		if (!restored_tabs.length)
			return;
		this.tabs = restored_tabs;
		const requested_index = Number.isInteger(saved.activeIndex) ? saved.activeIndex : 0;
		const active = restored_by_index.get(requested_index) || restored_tabs[0];
		this.active_tab_id = active.id;
		if (active.type === "directory") {
			this.rendered_directory_tab_id = active.id;
			this.show_directory(active);
		} else {
			this.show_file(active);
		}
		this.render();
		if (failures.length) {
			await this.nav_window_ref.modal_prompt.alert(
				"Some tabs could not be restored.",
				failures.map(message => `<div>${this.escape_html(message)}</div>`).join("")
			);
		}
	}

	workspace_snapshot() {
		this.sync_active_directory();
		const persistent_tabs = this.tabs.filter(tab => tab.type !== "terminal");
		const active = this.active_tab();
		const persistent_active = active?.type === "terminal"
			? persistent_tabs.findIndex(tab => tab.id === this.tabs.find(candidate => candidate.type !== "terminal")?.id)
			: persistent_tabs.findIndex(tab => tab.id === this.active_tab_id);
		return {
			tabs: persistent_tabs.map(tab => tab.type === "directory"
				? { type: "directory", path: this.current_path(tab) }
				: { type: "file", path: tab.path, displayPath: tab.display_path }),
			activeIndex: Math.max(0, persistent_active),
			updatedAt: Date.now(),
		};
	}

	persist_workspace() {
		if (this.restoring_workspace || !this.workspace)
			return;
		const snapshot = this.workspace_snapshot();
		Object.assign(this.workspace, snapshot);
		try {
			localStorage.setItem(this.workspace_storage_key, JSON.stringify(snapshot));
		} catch (error) {
			console.warn("Could not save local workspace snapshot.", error);
		}
		clearTimeout(this.workspace_save_timer);
		this.workspace_save_timer = setTimeout(async () => {
			try {
				await this.config_store.save();
				this.workspace_save_error_shown = false;
			} catch (error) {
				if (!this.workspace_save_error_shown) {
					this.workspace_save_error_shown = true;
					this.nav_window_ref.modal_prompt.alert("Could not save open tabs.", error.message || String(error));
				}
			}
		}, 250);
	}

	escape_html(value) {
		const element = document.createElement("div");
		element.textContent = value;
		return element.innerHTML;
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
		tab.modified = this.code_editor.is_modified(tab.path);
	}

	on_editor_change(path, modified) {
		const tab = this.tabs.find(candidate => candidate.type === "file" && candidate.path === path);
		if (tab) {
			tab.modified = modified;
			this.render();
		}
	}

	current_path(tab) {
		return ["file", "terminal"].includes(tab.type)
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

	open_directory(path) {
		const path_stack = this.nav_window_ref.build_path_stack(path || "/");
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
		await this.ready;
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
			modified: false,
		};
		this.code_editor.create_session(path, contents, display_path);
		this.tabs.push(tab);
		this.activate_tab(tab.id);
	}

	open_terminal(path) {
		const tab = { id: this.next_id++, type: "terminal", path: path || "/" };
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
		} else if (tab.type === "file") {
			this.show_file(tab);
		} else {
			this.show_terminal(tab);
		}
		this.persist_workspace();
	}

	activate_directory_view(tab) {
		this.show_directory(tab);
		if (this.rendered_directory_tab_id !== tab.id) {
			this.rendered_directory_tab_id = tab.id;
			this.nav_window_ref.refresh();
		}
	}

	show_directory(tab) {
		this.terminal_manager.hide();
		this.code_editor.deactivate();
		this.editor.style.display = "none";
		this.file_view.style.display = "flex";
		this.nav_window_ref.path_stack = tab.path_stack;
		this.nav_window_ref.path_stack_index = tab.path_stack_index;
		this.set_directory_controls_disabled(false);
	}

	show_file(tab) {
		this.terminal_manager.hide();
		this.nav_window_ref.directory_size_manager.cancel();
		this.file_view.style.display = "none";
		this.editor.style.display = "flex";
		this.set_directory_controls_disabled(true);
		this.editor_header.textContent = `Editing ${tab.display_path}`;
		this.code_editor.activate();
		this.code_editor.show(tab.path);
	}

	show_terminal(tab) {
		this.nav_window_ref.directory_size_manager.cancel();
		this.code_editor.deactivate();
		this.file_view.style.display = "none";
		this.editor.style.display = "none";
		this.terminal_view.style.display = "flex";
		this.set_directory_controls_disabled(true);
		this.terminal_manager.show(tab);
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
		const contents = this.code_editor.get_value(tab.path);
		try {
			await simple_spawn(["/usr/share/cockpit/navigator/scripts/write-to-file.py3", tab.path], contents);
			this.code_editor.mark_saved(tab.path);
			tab.modified = false;
			this.render();
		} catch (error) {
			this.nav_window_ref.modal_prompt.alert("Could not save file.", error.message || String(error));
		}
	}

	async close_tab(tab_id) {
		const closing_index = this.tabs.findIndex(tab => tab.id === tab_id);
		if (closing_index === -1)
			return;
		const closing_tab = this.tabs[closing_index];
		if (this.tabs.length === 1 && closing_tab.type === "directory")
			return;
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
		if (this.tabs.length === 1 && closing_tab.type !== "directory") {
			const path_stack = this.nav_window_ref.build_path_stack(closing_tab.parent_path || closing_tab.path || "/");
			this.tabs.push({
				id: this.next_id++,
				type: "directory",
				path_stack,
				path_stack_index: path_stack.length - 1,
			});
		}
		this.tabs.splice(closing_index, 1);
		if (was_active) {
			if (closing_tab.type === "file")
				this.code_editor.detach_session(closing_tab.path);
			const next_tab = this.tabs[Math.min(closing_index, this.tabs.length - 1)];
			this.active_tab_id = next_tab.id;
			if (next_tab.type === "directory") {
				this.activate_directory_view(next_tab);
			} else if (next_tab.type === "file") {
				this.show_file(next_tab);
			} else {
				this.show_terminal(next_tab);
			}
		}
		if (closing_tab.type === "file")
			this.code_editor.destroy_session(closing_tab.path);
		if (closing_tab.type === "terminal")
			this.terminal_manager.destroy(closing_tab.id);
		this.render();
		this.persist_workspace();
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
			tab_button.innerHTML = tab.type === "file" ? '<i class="fas fa-file-alt"></i>'
				: tab.type === "terminal" ? '<i class="fas fa-terminal"></i>' : '<i class="fas fa-folder"></i>';
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
			const is_last_directory = this.tabs.length === 1 && tab.type === "directory";
			close_button.disabled = is_last_directory;
			close_button.keep_disabled = is_last_directory;
			if (is_last_directory)
				close_button.classList.add("nav-tab-close-hidden");
			close_button.addEventListener("click", event => {
				event.stopPropagation();
				this.close_tab(tab.id);
			});

			tab_element.append(tab_button, close_button);
			this.tab_list.appendChild(tab_element);
		}
	}
}
