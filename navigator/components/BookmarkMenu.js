/*
	Cockpit Navigator - A File System Browser for Cockpit.
	Copyright (C) 2021 45Drives

	This file is part of Cockpit Navigator.
*/

import { NavDir } from "./NavDir.js";

export class BookmarkMenu {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.storage_key = "navigator-bookmarks";
		this.button = document.getElementById("nav-bookmarks-btn");
		this.menu = document.getElementById("nav-bookmarks-menu");

		this.button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggle();
		});

		document.documentElement.addEventListener("click", (event) => {
			if (!this.menu.contains(event.target))
				this.hide();
		});

		window.addEventListener("keydown", (event) => {
			if (event.key === "Escape")
				this.hide();
		});
	}

	get_bookmarks() {
		try {
			const bookmarks = JSON.parse(localStorage.getItem(this.storage_key) || "[]");
			return Array.isArray(bookmarks)
				? bookmarks.filter(path => typeof path === "string" && path.startsWith("/"))
				: [];
		} catch (error) {
			console.warn("Could not load Navigator bookmarks.", error);
			return [];
		}
	}

	save_bookmarks(bookmarks) {
		localStorage.setItem(this.storage_key, JSON.stringify(bookmarks));
	}

	add_current_directory() {
		const path = this.nav_window_ref.pwd().path_str();
		const bookmarks = this.get_bookmarks();
		if (!bookmarks.includes(path)) {
			bookmarks.push(path);
			bookmarks.sort((first, second) => first.localeCompare(second));
			this.save_bookmarks(bookmarks);
		}
		this.render();
	}

	remove(path) {
		this.save_bookmarks(this.get_bookmarks().filter(bookmark => bookmark !== path));
		this.render();
	}

	navigate(path) {
		this.hide();
		this.nav_window_ref.cd(new NavDir(path));
	}

	render() {
		this.menu.replaceChildren();

		const add_button = document.createElement("button");
		add_button.type = "button";
		add_button.className = "nav-bookmark-add";
		add_button.innerHTML = '<i class="fas fa-bookmark"></i><span>Bookmark current directory</span>';
		add_button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.add_current_directory();
		});
		this.menu.appendChild(add_button);

		const bookmarks = this.get_bookmarks();
		if (bookmarks.length === 0) {
			const empty_message = document.createElement("div");
			empty_message.className = "nav-bookmarks-empty";
			empty_message.textContent = "No bookmarked directories";
			this.menu.appendChild(empty_message);
			return;
		}

		const separator = document.createElement("div");
		separator.className = "nav-bookmarks-separator";
		this.menu.appendChild(separator);

		for (const path of bookmarks) {
			const item = document.createElement("div");
			item.className = "nav-bookmark-item";

			const path_button = document.createElement("button");
			path_button.type = "button";
			path_button.className = "nav-bookmark-path";
			path_button.title = path;
			path_button.innerHTML = '<i class="fas fa-folder"></i>';
			const label = document.createElement("span");
			label.textContent = path;
			path_button.appendChild(label);
			path_button.addEventListener("click", (event) => {
				event.stopPropagation();
				this.navigate(path);
			});

			const remove_button = document.createElement("button");
			remove_button.type = "button";
			remove_button.className = "nav-bookmark-remove";
			remove_button.title = `Remove ${path} from bookmarks`;
			remove_button.setAttribute("aria-label", `Remove ${path} from bookmarks`);
			remove_button.innerHTML = '<i class="fas fa-times"></i>';
			remove_button.addEventListener("click", (event) => {
				event.stopPropagation();
				this.remove(path);
			});

			item.append(path_button, remove_button);
			this.menu.appendChild(item);
		}
	}

	show() {
		this.render();
		this.menu.style.display = "flex";
		this.button.setAttribute("aria-expanded", "true");
	}

	hide() {
		this.menu.style.display = "none";
		this.button.setAttribute("aria-expanded", "false");
	}

	toggle() {
		if (this.menu.style.display === "flex")
			this.hide();
		else
			this.show();
	}
}
