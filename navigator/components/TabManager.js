/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 45Drives

	This file is part of Cockpit Navigator.
*/

export class TabManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.tab_list = document.getElementById("nav-tab-list");
		this.new_tab_button = document.getElementById("nav-new-tab-btn");
		this.tabs = [];
		this.next_id = 1;
		this.active_tab_id = null;

		this.new_tab_button.addEventListener("click", () => this.create_tab());
		this.nav_window_ref.navigation_change_handler = () => {
			this.sync_active_tab();
			this.render();
		};

		const initial_tab = this.tab_from_current_window();
		this.tabs.push(initial_tab);
		this.active_tab_id = initial_tab.id;
		this.render();
	}

	tab_from_current_window() {
		return {
			id: this.next_id++,
			path_stack: this.nav_window_ref.path_stack,
			path_stack_index: this.nav_window_ref.path_stack_index,
		};
	}

	sync_active_tab() {
		const active_tab = this.tabs.find(tab => tab.id === this.active_tab_id);
		if (!active_tab)
			return;
		active_tab.path_stack = this.nav_window_ref.path_stack;
		active_tab.path_stack_index = this.nav_window_ref.path_stack_index;
	}

	current_path(tab) {
		return tab.path_stack[tab.path_stack_index].path_str();
	}

	create_tab() {
		this.sync_active_tab();
		const path_stack = this.nav_window_ref.build_path_stack(
			this.nav_window_ref.pwd().path_str()
		);
		const tab = {
			id: this.next_id++,
			path_stack,
			path_stack_index: path_stack.length - 1,
		};
		this.tabs.push(tab);
		this.activate_tab(tab.id);
	}

	activate_tab(tab_id) {
		if (tab_id === this.active_tab_id)
			return;

		this.sync_active_tab();
		const tab = this.tabs.find(candidate => candidate.id === tab_id);
		if (!tab)
			return;

		this.active_tab_id = tab.id;
		this.nav_window_ref.path_stack = tab.path_stack;
		this.nav_window_ref.path_stack_index = tab.path_stack_index;
		this.render();
		this.nav_window_ref.refresh();
	}

	close_tab(tab_id) {
		if (this.tabs.length === 1)
			return;

		const closing_index = this.tabs.findIndex(tab => tab.id === tab_id);
		if (closing_index === -1)
			return;

		const was_active = this.active_tab_id === tab_id;
		this.tabs.splice(closing_index, 1);
		if (was_active) {
			const next_tab = this.tabs[Math.min(closing_index, this.tabs.length - 1)];
			this.active_tab_id = next_tab.id;
			this.nav_window_ref.path_stack = next_tab.path_stack;
			this.nav_window_ref.path_stack_index = next_tab.path_stack_index;
		}
		this.render();
		if (was_active)
			this.nav_window_ref.refresh();
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
			tab_button.innerHTML = '<i class="fas fa-folder"></i>';
			const label = document.createElement("span");
			label.textContent = path === "/" ? "/" : path.split("/").filter(Boolean).pop();
			tab_button.appendChild(label);
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
