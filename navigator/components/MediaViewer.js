const IMAGE_LIMIT = 50 * 1024 * 1024;
const VIDEO_LIMIT = 200 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
	"avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
]);
const VIDEO_EXTENSIONS = new Set([
	"m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm",
]);

export class MediaViewer {
	constructor(nav_window_ref) {
		this.nav_window_ref = nav_window_ref;
		this.object_urls = new Set();
		this.build_video_modal();
	}

	extension(entry) {
		const name = entry?.filename || "";
		return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
	}

	is_candidate(entry) {
		if (entry?.nav_type !== "file")
			return false;
		const extension = this.extension(entry);
		return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
	}

	path_for(entry) {
		return typeof entry?.get_link_target_path === "function" ? entry.get_link_target_path() : entry.path_str();
	}

	async mime_type(path) {
		return (await cockpit.spawn(
			["file", "-bL", "--mime-type", path],
			{ superuser: "try", err: "out" }
		)).trim();
	}

	async open_entry(entry) {
		const path = this.path_for(entry);
		let mime;
		try {
			mime = await this.mime_type(path);
		} catch (error) {
			await this.nav_window_ref.modal_prompt.alert("Could not inspect media file.", error.message || String(error));
			return false;
		}
		if (mime.startsWith("image/")) {
			await this.open_image(entry);
			return true;
		}
		if (mime.startsWith("video/")) {
			await this.open_video(entry, mime);
			return true;
		}
		return false;
	}

	visible_images() {
		return this.nav_window_ref.entries.filter(entry => entry.visible && IMAGE_EXTENSIONS.has(this.extension(entry)));
	}

	async read_blob(entry, mime, limit) {
		if (Number(entry.stat?.size) > limit)
			throw new Error(`File exceeds the ${Math.round(limit / 1024 / 1024)} MB preview limit.`);
		const path = this.path_for(entry);
		const contents = await cockpit.file(path, {
			binary: true,
			max_read_size: limit,
			superuser: "try",
		}).read();
		if (contents === null)
			throw new Error("File no longer exists.");
		const blob = new Blob([contents], { type: mime });
		const url = URL.createObjectURL(blob);
		this.object_urls.add(url);
		return url;
	}

	image_dimensions(url) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
			image.onerror = () => reject(new Error("The browser could not decode this image."));
			image.src = url;
		});
	}

	async load_image_item(item) {
		if (item.loaded || item.loading)
			return item.loading;
		item.loading = (async () => {
			const mime = await this.mime_type(item.path);
			if (!mime.startsWith("image/"))
				throw new Error("File is not a supported image.");
			const url = await this.read_blob(item.entry, mime, IMAGE_LIMIT);
			const dimensions = await this.image_dimensions(url);
			item.loaded = { src: url, ...dimensions, alt: item.name, path: item.path, name: item.name, entry: item.entry };
			return item.loaded;
		})();
		try {
			return await item.loading;
		} finally {
			item.loading = null;
		}
	}

	async open_image(entry) {
		const entries = this.visible_images();
		if (!entries.includes(entry))
			entries.push(entry);
		const items = entries.map(candidate => ({
			type: "html",
			html: '<div class="nav-media-loading"><i class="fas fa-spinner fa-spin"></i><span>Loading image…</span></div>',
			entry: candidate,
			path: this.path_for(candidate),
			name: candidate.filename,
		}));
		const index = entries.indexOf(entry);
		try {
			items[index] = await this.load_image_item(items[index]);
		} catch (error) {
			await this.nav_window_ref.modal_prompt.alert("Could not preview image.", error.message || String(error));
			this.release_urls();
			return;
		}

		const lightbox = new PhotoSwipeLightbox({
			dataSource: items,
			pswpModule: PhotoSwipe,
			index,
			bgOpacity: 0.92,
			preload: [0, 0],
			showHideAnimationType: "fade",
			errorMsg: "The image cannot be loaded.",
		});
		let closed = false;
		this.lightbox = lightbox;
		lightbox.on("uiRegister", () => {
			lightbox.pswp.ui.registerElement({
				name: "navigator-caption",
				order: 9,
				isButton: false,
				appendTo: "root",
				html: "",
			});
		});
		lightbox.on("change", () => {
			const current_index = lightbox.pswp.currIndex;
			const current = items[current_index];
			const caption = lightbox.pswp.element?.querySelector(".pswp__navigator-caption");
			if (caption)
				caption.textContent = current.name || current.entry?.filename || "";
			if (current.loaded || current.src)
				return;
			this.load_image_item(current).then(loaded => {
				if (closed) {
					URL.revokeObjectURL(loaded.src);
					this.object_urls.delete(loaded.src);
					return;
				}
				items[current_index] = loaded;
				if (lightbox.pswp && lightbox.pswp.currIndex === current_index)
					lightbox.pswp.refreshSlideContent(current_index);
			}).catch(error => {
				items[current_index] = {
					type: "html",
					html: `<div class="nav-media-error"><i class="fas fa-exclamation-triangle"></i><span>${this.escape_html(error.message || String(error))}</span></div>`,
					name: current.name,
				};
				lightbox.pswp?.refreshSlideContent(current_index);
			});
		});
		lightbox.on("destroy", () => {
			closed = true;
			this.release_urls();
			this.lightbox = null;
		});
		lightbox.init();
		lightbox.loadAndOpen(index);
	}

	build_video_modal() {
		this.video_modal = document.createElement("div");
		this.video_modal.className = "nav-media-video-modal";
		this.video_modal.setAttribute("role", "dialog");
		this.video_modal.setAttribute("aria-modal", "true");
		this.video_modal.hidden = true;
		const dialog = document.createElement("div");
		dialog.className = "nav-media-video-dialog";
		const header = document.createElement("div");
		header.className = "nav-media-video-header";
		this.video_title = document.createElement("strong");
		const actions = document.createElement("div");
		actions.className = "nav-media-video-actions";
		this.video_download = document.createElement("a");
		this.video_download.className = "pf-c-button pf-m-secondary";
		this.video_download.innerHTML = '<i class="fas fa-download"></i>';
		this.video_download.title = "Download";
		this.video_download.setAttribute("download", "");
		const close = document.createElement("button");
		close.type = "button";
		close.className = "pf-c-button pf-m-secondary";
		close.innerHTML = '<i class="fas fa-times"></i>';
		close.title = "Close";
		close.onclick = () => this.close_video();
		actions.append(this.video_download, close);
		header.append(this.video_title, actions);
		this.video = document.createElement("video");
		this.video.className = "nav-media-video";
		this.video.controls = true;
		this.video.preload = "metadata";
		this.video.addEventListener("error", () => {
			if (!this.video.getAttribute("src")) return;
			this.nav_window_ref.modal_prompt.alert(
				"Video format is not supported.",
				"The browser cannot decode this video or codec. You can still download the file."
			);
		});
		dialog.append(header, this.video);
		this.video_modal.appendChild(dialog);
		this.video_modal.addEventListener("click", event => {
			if (event.target === this.video_modal) this.close_video();
		});
		document.body.appendChild(this.video_modal);
		window.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.video_modal.hidden) this.close_video();
		});
	}

	async open_video(entry, mime) {
		try {
			const url = await this.read_blob(entry, mime, VIDEO_LIMIT);
			this.video.src = url;
			this.video_title.textContent = entry.filename;
			this.video_download.href = url;
			this.video_download.download = entry.filename;
			this.video_modal.hidden = false;
			await this.video.play().catch(() => {});
		} catch (error) {
			this.release_urls();
			await this.nav_window_ref.modal_prompt.alert("Could not preview video.", error.message || String(error));
		}
	}

	close_video() {
		this.video.pause();
		this.video.removeAttribute("src");
		this.video.load();
		this.video_modal.hidden = true;
		this.release_urls();
	}

	release_urls() {
		for (const url of this.object_urls)
			URL.revokeObjectURL(url);
		this.object_urls.clear();
	}

	escape_html(value) {
		const element = document.createElement("div");
		element.textContent = value;
		return element.innerHTML;
	}
}
