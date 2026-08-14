const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);

export class GalleryManager {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.generation = 0;
		this.urls = new Set();
		this.thumbnail_entries = new Set();
		this.missing = new Set();
		this.notice_signature = "";
		this.queue = [];
		this.active = 0;
		this.max_concurrent = 4;
	}

	extension(entry) {
		return entry.filename.includes(".") ? entry.filename.split(".").pop().toLowerCase() : "";
	}

	media_type(entry) {
		const extension = this.extension(entry);
		if (IMAGE_EXTENSIONS.has(extension)) return "image";
		if (VIDEO_EXTENSIONS.has(extension)) return "video";
		return null;
	}

	stop() {
		this.generation++;
		this.observer?.disconnect();
		this.observer = null;
		this.queue = [];
		for (const entry of this.thumbnail_entries) {
			const icon = entry.dom_element?.nav_item_icon;
			icon?.classList.remove("nav-gallery-has-thumbnail");
			icon?.querySelectorAll(".nav-gallery-thumbnail, .nav-gallery-video-badge").forEach(element => element.remove());
		}
		this.thumbnail_entries.clear();
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls.clear();
	}

	render(entries) {
		this.stop();
		const generation = this.generation;
		this.missing.clear();
		const media = entries.filter(entry => this.media_type(entry) && entry.visible);
		for (const entry of media) {
			entry.dom_element.classList.add("nav-gallery-media");
			entry.dom_element.nav_item_icon.classList.add("nav-gallery-placeholder");
		}
		if (!("IntersectionObserver" in window)) {
			this.queue.push(...media.map(entry => ({ entry, generation })));
			this.drain_queue();
			return;
		}
		this.observer = new IntersectionObserver(records => {
			for (const record of records) {
				if (!record.isIntersecting) continue;
				this.observer?.unobserve(record.target);
				const entry = record.target._nav_gallery_entry;
				if (entry) this.queue.push({ entry, generation });
			}
			this.drain_queue();
		}, { root: this.nav_window_ref.window, rootMargin: "200px 0px", threshold: 0.01 });
		for (const entry of media) {
			entry.dom_element._nav_gallery_entry = entry;
			this.observer.observe(entry.dom_element);
		}
	}

	drain_queue() {
		while (this.active < this.max_concurrent && this.queue.length) {
			const { entry, generation } = this.queue.shift();
			if (generation !== this.generation) continue;
			this.active++;
			this.render_entry(entry, generation).finally(() => {
				this.active--;
				if (generation === this.generation) this.show_dependency_notice();
				this.drain_queue();
			});
		}
	}

	async render_entry(entry, generation) {
		const type = this.media_type(entry);
		try {
			const output = await cockpit.spawn(
				["/usr/share/cockpit/navigator/scripts/media-thumbnail.py3", type, entry.path_str()],
				{ superuser: "try", err: "message" },
			);
			if (generation !== this.generation) return;
			const result = JSON.parse(output);
			if (result.status === "missing") {
				this.missing.add(result.package);
				return;
			}
			if (result.status !== "ok") return;
			const contents = await cockpit.file(result.path, { binary: true, superuser: "try" }).read();
			if (generation !== this.generation || contents === null) return;
			const url = URL.createObjectURL(new Blob([contents], { type: "image/jpeg" }));
			this.urls.add(url);
			const image = document.createElement("img");
			image.className = "nav-gallery-thumbnail";
			image.alt = "";
			image.src = url;
			const icon = entry.dom_element.nav_item_icon;
			icon.querySelectorAll(".nav-gallery-thumbnail, .nav-gallery-video-badge").forEach(element => element.remove());
			icon.classList.add("nav-gallery-has-thumbnail");
			icon.appendChild(image);
			this.thumbnail_entries.add(entry);
			if (type === "video") {
				const badge = document.createElement("i");
				badge.className = "fas fa-play nav-gallery-video-badge";
				icon.appendChild(badge);
			}
		} catch (error) {
			console.warn(`Could not create thumbnail for ${entry.path_str()}`, error);
		}
	}

	show_dependency_notice() {
		if (!this.missing.size) return;
		const signature = [...this.missing].sort().join(",");
		if (signature === this.notice_signature) return;
		this.notice_signature = signature;
		const apt_packages = [...this.missing].join(" ");
		const dnf_packages = [...this.missing].map(name => name === "imagemagick" ? "ImageMagick" : name).join(" ");
		this.nav_window_ref.modal_prompt.alert(
			"Gallery thumbnails are unavailable",
			`Install the missing dependencies and reload Navigator:<br><br>` +
			`<code>sudo apt install ${apt_packages}</code><br>` +
			`or<br><code>sudo dnf install ${dnf_packages}</code><br><br>` +
			`Files remain available with their regular icons.`,
		);
	}
}
