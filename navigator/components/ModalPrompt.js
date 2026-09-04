/* 
	ModalPrompt - A Custom Prompt Module for Cockpit Plugins.
	Copyright (C) 2021 Josh Boudreau      <jboudreau@45drives.com>

	This program is free software: you can redistribute it and/or modify
	it under the terms of the Lesser GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	Lesser GNU General Public License for more details.

	You should have received a copy of the Lesser GNU General Public License
	along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @typedef {Object} Request
 * @property {string} label
 * @property {"text"|"checkbox"|"select"} type
 * @property {string|undefined} default
 */

let primary_btn = "pf-m-primary";
let secondary_btn = "pf-m-secondary";
let danger_btn = "pf-m-danger";
let all_btn = [primary_btn, secondary_btn, danger_btn];

export class ModalPrompt {
	constructor() {
		this.ok = document.createElement("button");
		this.ok.innerText = "OK";
		this.ok.classList.add("pf-c-button", "pf-m-primary");
		this.cancel = document.createElement("button");
		this.cancel.innerText = "Cancel";
		this.cancel.classList.add("pf-c-button", "pf-m-secondary");
		this.yes = document.createElement("button");
		this.yes.innerText = "Yes";
		this.yes.classList.add("pf-c-button", "pf-m-primary");
		this.no = document.createElement("button");
		this.no.innerText = "No";
		this.no.classList.add("pf-c-button", "pf-m-secondary");
		this.construct_element();
	}

	construct_element() {
		let bg = this.modal = document.createElement("div");
		bg.classList.add("modal");
		bg.style.overflowY = "auto";
		let fg = document.createElement("div");
		fg.classList.add("modal-dialog");
		bg.appendChild(fg);
		let popup = document.createElement("div");
		popup.classList.add("modal-content");
		fg.appendChild(popup);
		let header = document.createElement("div");
		header.classList.add("modal-header");
		popup.appendChild(header);
		let header_text = this.header = document.createElement("h4");
		header_text.classList.add("modal-title");
		header.appendChild(header_text);
		let body = this.body = document.createElement("div");
		body.classList.add("modal-body");
		popup.appendChild(body);
		let footer = this.footer = document.createElement("div");
		footer.classList.add("modal-footer");
		footer.style.display = "flex";
		footer.style.flexFlow = "row no-wrap";
		footer.style.justifyContent = "flex-end";
		popup.appendChild(footer);
		document.body.appendChild(this.modal);
	}

	show() {
		this.modal.style.display = "block";
	}

	hide() {
		this.modal.style.display = "none";
	}

	/**
	 * 
	 * @param {string} header 
	 */
	set_header(header) {
		this.header.innerText = header;
	}

	/**
	 * 
	 * @param {string} message 
	 */
	set_body(message) {
		this.body.innerHTML = "";
		this.body.innerHTML = message;
	}

	/**
	 * 
	 * @param {string} header 
	 * @param {string} message 
	 * @returns {Promise}
	 */
	alert(header, message = "") {
		this.set_header(header);
		this.set_body(message);
		this.footer.innerHTML = "";
		this.footer.appendChild(this.ok);
		this.show();
		this.ok.focus();
		return new Promise((resolve, reject) => {
			this.ok.onclick = () => {
				resolve();
				this.hide();
			}
		});
	}

	/**
	 * 
	 * @param {string} header 
	 * @param {string} message 
	 * @param {boolean} danger 
	 * @returns {Promise<boolean>}
	 */
	confirm(header, message = "", danger = false) {
		this.set_header(header);
		this.set_body(message);
		this.footer.innerHTML = "";
		this.footer.append(this.no, this.yes);
		this.yes.classList.remove(... all_btn);
		if (danger)
			this.yes.classList.add(danger_btn);
		else
			this.yes.classList.add(primary_btn);
		this.show();
		if (danger)
			this.no.focus();
		else
			this.yes.focus();
		return new Promise((resolve, reject) => {
			let resolve_true = () => {
				resolve(true);
				this.hide();
			}
			let resolve_false = () => {
				resolve(false);
				this.hide();
			}
			this.yes.onclick = resolve_true;
			this.no.onclick = resolve_false;
		});
	}

	choose(header, message, choices) {
		this.set_header(header);
		this.set_body(message);
		this.footer.innerHTML = "";
		this.show();
		return new Promise(resolve => {
			for (const choice of choices) {
				const button = document.createElement("button");
				button.type = "button";
				button.innerText = choice.label;
				button.classList.add("pf-c-button", choice.danger ? "pf-m-danger" : (choice.primary ? "pf-m-primary" : "pf-m-secondary"));
				button.onclick = () => {
					this.hide();
					resolve(choice.value);
				};
				this.footer.appendChild(button);
			}
			this.footer.firstElementChild?.focus();
		});
	}

	choose_list(header, message, choices) {
		this.set_header(header);
		this.set_body(message);
		this.footer.innerHTML = "";
		const list = document.createElement("div");
		list.className = "nav-modal-choice-list";
		this.body.appendChild(list);
		this.footer.appendChild(this.cancel);
		this.show();
		return new Promise(resolve => {
			for (const choice of choices) {
				const button = document.createElement("button");
				button.type = "button";
				button.classList.add("pf-c-button", choice.primary ? "pf-m-primary" : "pf-m-secondary");
				button.innerText = choice.label;
				button.title = choice.label;
				button.onclick = () => {
					this.hide();
					resolve(choice.value);
				};
				list.appendChild(button);
			}
			this.cancel.onclick = () => {
				this.hide();
				resolve(null);
			};
			list.firstElementChild?.focus();
		});
	}

	choose_row(header, columns, rows, actionLabel = "Choose") {
		this.set_header(header);
		this.body.innerHTML = "";
		this.footer.innerHTML = "";
		const table = document.createElement("table");
		table.className = "nav-choice-table";
		const head = document.createElement("thead");
		const headRow = document.createElement("tr");
		for (const column of columns) {
			const cell = document.createElement("th");
			cell.innerText = column;
			headRow.appendChild(cell);
		}
		head.appendChild(headRow);
		const body = document.createElement("tbody");
		const group = `nav-choice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let selected = rows[0]?.value ?? null;
		rows.forEach((row, index) => {
			const tableRow = document.createElement("tr");
			const labelCell = document.createElement("td");
			labelCell.innerText = row.label;
			const optionCell = document.createElement("td");
			const option = document.createElement("input");
			option.type = "radio";
			option.name = group;
			option.value = row.value;
			option.checked = index === 0;
			option.setAttribute("aria-label", `Select ${row.label}`);
			option.onchange = () => { selected = row.value; };
			tableRow.onclick = () => {
				option.checked = true;
				selected = row.value;
			};
			optionCell.appendChild(option);
			tableRow.append(labelCell, optionCell);
			body.appendChild(tableRow);
		});
		table.append(head, body);
		this.body.appendChild(table);
		const action = document.createElement("button");
		action.type = "button";
		action.innerText = actionLabel;
		action.classList.add("pf-c-button", "pf-m-primary");
		this.footer.append(this.cancel, action);
		this.show();
		action.focus();
		return new Promise(resolve => {
			action.onclick = () => {
				this.hide();
				resolve(selected);
			};
			this.cancel.onclick = () => {
				this.hide();
				resolve(null);
			};
		});
	}

	/**
	 * 
	 * @param {string} header 
	 * @param {Object.<string, Request>} requests 
	 * @returns {Promise<Object|string>}
	 */
	prompt(header, requests) {
		this.set_header(header);
		this.body.innerHTML = "";
		this.footer.innerHTML = "";
		this.footer.append(this.cancel, this.ok);
		let inputs = [];
		let simple_prompt = false;


		if (typeof requests === "string") {
			let label = requests;
			simple_prompt = true;
			requests = {
				"key": {
					"label": label,
					"type": "text"
				}
			}
		}

		let req_holder = document.createElement("div");
		req_holder.style.display = "flex";
		req_holder.style.flexFlow = "column nowrap";
		req_holder.style.alignItems = "stretch";
		this.body.appendChild(req_holder);
		for(let key of Object.keys(requests)) {
			let row = document.createElement("div");
			row.style.display = "flex";
			row.style.alignItems = "baseline";
			row.style.padding = "2px";
			let request = requests[key];
			let label = document.createElement("label");
			label.innerText = request.label;
			label.htmlFor = key;
			label.style.paddingRight = "1em";
			label.style.flexBasis = "0";
			label.style.flexGrow = "1";
			let req = document.createElement(request.type === "select" ? "select" : "input");
			req.id = key;
			if (req instanceof HTMLInputElement)
				req.type = request.type;
			req.style.flexBasis = "0";
			if (request.hasOwnProperty("default")) {
				if (req instanceof HTMLInputElement && request.type === "checkbox")
					req.checked = request.default;
				else
					req.value = request.default;
			}
			if (request.options?.length && req instanceof HTMLInputElement) {
				const datalist = document.createElement("datalist");
				datalist.id = `${key}-options`;
				for (const option of request.options) {
					const item = document.createElement("option");
					item.value = option;
					datalist.appendChild(item);
				}
				req.setAttribute("list", datalist.id);
				this.body.appendChild(datalist);
			}
			if (request.type === "select") {
				for (const option of request.options || []) {
					const item = document.createElement("option");
					item.value = option.value;
					item.innerText = option.label;
					req.appendChild(item);
				}
			}
			row.append(label, req);
			req_holder.appendChild(row);
			inputs.push(req);
			switch (request.type) {
				case "text":
				case "select":
					req.style.flexGrow = "3";
					break;
				case "checkbox":
					label.style.cursor = req.style.cursor = "pointer";
					break;
				default:
					break;
			}
		}

		this.show();
		inputs[0].focus();
		for (let i = 0; i < inputs.length - 1; i++) {
			inputs[i].onchange = () => {
				inputs[i+1].focus();
			}
		}
		inputs[inputs.length - 1].onchange = () => {
			this.ok.focus();
		}
		return new Promise((resolve, reject) => {
			this.ok.onclick = () => {
				let response
				if (simple_prompt) {
					response = inputs[0].value;
				} else {
					response = {};
					for (let input of inputs) {
						switch (input.type) {
							case "checkbox":
								response[input.id] = input.checked;
								break;
							case "text":
							default:
								response[input.id] = input.value;
								break;
						}
					}
				}
				resolve(response);
				this.hide();
			}
			this.cancel.onclick = () => {
				resolve(null);
				this.hide();
			}
		});
	}
}
