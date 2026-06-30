// @ts-strict-ignore
/* -*- js-indent-level: 8 -*- */
/*
 * Copyright the Collabora Online contributors.
 *
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Util.OnDemandRenderer - helper for rendering entries on demand (when visible)
 */

declare var JSDialog: any;

function onDemandRenderer(
	builder: JSBuilder,
	controlId: string,
	controlType: string,
	entryId: number,
	placeholder: Element,
	parentContainer: Element,
	entryText: string | undefined,
) {
	const setupOnDemandRenderer = () => {
		// avoid races, might be already updated
		if (!parentContainer.contains(placeholder)) return;

		const cachedComboboxEntries = builder.rendersCache[controlId];
		let requestRender = true;

		// Diagnostic: gated on window.__l10nIconviewDebug so it stays
		// quiet by default but can be flipped by tests / dev sessions
		// to trace why ribbon iconview entries (controlType ==
		// 'iconview') don't pick up rendersCache images even though
		// the sidebar's identical control does. Logs whether the cache
		// exists for this controlId and whether the specific entry has
		// an image — the asymmetry vs the sidebar path is what we want
		// to see.
		if ((window as any).__l10nIconviewDebug) {
			const cacheState = !cachedComboboxEntries
				? 'no-entry'
				: !cachedComboboxEntries.images
					? 'no-images-map'
					: cachedComboboxEntries.images[entryId]
						? 'hit'
						: 'miss';
			(window as any).console.log(
				'[OnDemandRenderer] controlType=' + controlType +
				' controlId=' + controlId +
				' entryId=' + entryId +
				' cacheState=' + cacheState +
				' cacheKeys=' +
				(cachedComboboxEntries
					? Object.keys(cachedComboboxEntries.images || {}).length
					: 0),
			);
		}

		if (cachedComboboxEntries && cachedComboboxEntries.images[entryId]) {
			const originalClass = placeholder.classList;
			window.L.DomUtil.remove(placeholder);
			placeholder = window.L.DomUtil.create('img', '', parentContainer);
			const placeholderImg = placeholder as HTMLImageElement;
			placeholderImg.src = cachedComboboxEntries.images[entryId];
			placeholderImg.alt = entryText;
			placeholderImg.title = entryText;
			originalClass.forEach((className: string) =>
				placeholderImg.classList.add(className),
			);
			requestRender = !cachedComboboxEntries.persistent;
		}

		if (requestRender) {
			// render on demand
			var onIntersection = (entries: any) => {
				entries.forEach((entry: any) => {
					if (entry.isIntersecting) {
						builder.callback(
							controlType,
							'render_entry',
							{ id: controlId },
							entryId +
								';' +
								Math.floor(100 * window.devicePixelRatio) +
								';' +
								Math.floor(100 * window.devicePixelRatio),
							builder,
						);
					}
				});
			};

			var observer = new IntersectionObserver(onIntersection, {
				root: null,
				threshold: 0.01, // percentage of visible area
			});

			observer.observe(placeholder);
		}
	};

	// If no first tile yet, delay sending the render request.
	TileManager.appendAfterFirstTileTask(setupOnDemandRenderer);
}

JSDialog.OnDemandRenderer = onDemandRenderer;
