/*
 * Open data portal providers.
 *
 * Each provider turns a dataset URL into a portal-neutral "record" that the
 * Zotero integration (opendata-cite.js) saves as a `dataset` item. Nothing in
 * this file touches Zotero APIs, so it can be unit-tested under Node with a
 * fake `ctx`.
 *
 * ctx = {
 *   fetchJSON(url) -> Promise<any>      rejects on non-2xx
 *   fetchText(url) -> Promise<string>   rejects on non-2xx
 *   prefs: {
 *     dateSource: 'dataUpdated' | 'metadataUpdated' | 'published' | 'created',
 *     language: 'en-US'   // preferred language for multilingual portals
 *   }
 * }
 *
 * record = {
 *   provider, url,
 *   fields: { <Zotero dataset field>: string },  // `extra` holds portal IDs
 *   creators: [{ name, creatorType }],   // institutional (single-field) names
 *   tags: [string],
 *   noteHTML: string | null,
 * }
 */

var OpenDataProviders = (function () {
	'use strict';

	const SOCRATA_ID = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
	const GEOMETRY_TYPES = new Set([
		'point', 'multipoint', 'line', 'multiline', 'polygon', 'multipolygon', 'location',
	]);

	// Portal display names don't change while Zotero is running
	const portalNameCache = new Map();

	function escapeHTML(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	/** Unix seconds or ISO string -> 'YYYY-MM-DD' (UTC), or '' */
	function isoDate(value) {
		if (value === undefined || value === null || value === '') return '';
		let d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
		if (isNaN(d)) return '';
		return d.toISOString().slice(0, 10);
	}

	function unique(arr) {
		return [...new Set(arr.filter(Boolean))];
	}

	/**
	 * Portal identifiers live in Extra rather than the Identifier/Format/
	 * Library Catalog fields: CSL styles print those as "No. Inkn–Q76z",
	 * replace APA's "[Dataset]" with "[CSV, PDF]", or repeat the hostname.
	 */
	function extraLines(entries) {
		return Object.entries(entries)
			.filter(([, value]) => value)
			.map(([key, value]) => `${key}: ${value}`)
			.join('\n');
	}

	function pickDate(dates, source) {
		let order = {
			dataUpdated: ['dataUpdated', 'metadataUpdated', 'published', 'created'],
			metadataUpdated: ['metadataUpdated', 'dataUpdated', 'published', 'created'],
			published: ['published', 'created', 'dataUpdated', 'metadataUpdated'],
			created: ['created', 'published', 'dataUpdated', 'metadataUpdated'],
		}[source] || ['dataUpdated', 'metadataUpdated', 'published', 'created'];
		for (let key of order) {
			if (dates[key]) return dates[key];
		}
		return '';
	}

	function parseURL(input) {
		try {
			let url = new URL(String(input).trim());
			if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
			return url;
		}
		catch (e) {
			return null;
		}
	}

	function pathSegments(url) {
		return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	}

	/** Build the "Dataset details" child note from labelled rows and optional sections */
	function buildNote(title, rows, sections = []) {
		let html = `<h1>Dataset details: ${escapeHTML(title)}</h1>\n<table>\n`;
		for (let [label, value, isLink] of rows) {
			if (!value) continue;
			let cell = isLink
				? `<a href="${escapeHTML(value)}">${escapeHTML(value)}</a>`
				: escapeHTML(value);
			html += `<tr><th>${escapeHTML(label)}</th><td>${cell}</td></tr>\n`;
		}
		html += '</table>\n';
		for (let section of sections) {
			if (section) html += section;
		}
		return html;
	}

	// ------------------------------------------------------------------------
	// Socrata (data.cityofnewyork.us, data.cityofchicago.org, data.sfgov.org, ...)
	// API: https://{host}/api/views/{4x4}.json
	// ------------------------------------------------------------------------

	const socrata = {
		id: 'socrata',
		label: 'Socrata',

		/**
		 * Accepts any URL with a 4x4 dataset ID path segment, e.g.
		 *   /City-Government/Centerline/inkn-q76z/about_data
		 *   /d/inkn-q76z   /resource/inkn-q76z.json   /api/views/inkn-q76z
		 */
		match(input) {
			let url = parseURL(input);
			if (!url) return null;
			let ids = pathSegments(url)
				.map(s => s.replace(/\.[a-z]+$/i, '').toLowerCase())
				.filter(s => SOCRATA_ID.test(s));
			if (!ids.length) return null;
			return { origin: url.origin, host: url.host, datasetID: ids[ids.length - 1] };
		},

		async portalName(origin, datasetID, ctx) {
			if (portalNameCache.has(origin)) return portalNameCache.get(origin);
			let name = '';
			try {
				// Dataset pages are titled "<Dataset> | <Portal name>"
				let html = await ctx.fetchText(`${origin}/d/${datasetID}`);
				let m = html.match(/<title>([^<]*)<\/title>/i);
				if (m && m[1].includes('|')) {
					// "Crimes | City of Chicago | Data Portal" -> "City of Chicago Data Portal"
					name = decodeEntities(m[1]).split('|').slice(1)
						.map(s => s.trim()).filter(Boolean).join(' ');
				}
			}
			catch (e) {}
			if (!name) name = new URL(origin).host;
			portalNameCache.set(origin, name);
			return name;
		},

		async rowCount(origin, datasetID, ctx) {
			try {
				let rows = await ctx.fetchJSON(
					`${origin}/resource/${datasetID}.json?$select=count(*)`
				);
				let value = rows && rows[0] && Object.values(rows[0])[0];
				return value !== undefined ? Number(value) : null;
			}
			catch (e) {
				return null;
			}
		},

		async fetch(match, ctx) {
			let { origin, datasetID } = match;
			let view = await ctx.fetchJSON(`${origin}/api/views/${datasetID}.json`);
			if (!view || view.id !== datasetID || !view.name) {
				throw new Error(`Not a Socrata dataset: ${datasetID}`);
			}
			let [portal, rowCount] = await Promise.all([
				this.portalName(origin, datasetID, ctx),
				view.assetType === 'dataset' || view.viewType === 'tabular'
					? this.rowCount(origin, datasetID, ctx)
					: null,
			]);
			return socrata.toRecord(view, { origin, portal, rowCount }, ctx.prefs || {});
		},

		/** Pure mapping from /api/views JSON to a record (exported for tests) */
		toRecord(view, { origin, portal, rowCount }, prefs) {
			let custom = (view.metadata && view.metadata.custom_fields) || {};
			let agency = findCustomField(custom, /^(publishing )?(agency|department|publisher|organization)$/i);
			let author = agency || view.attribution || (view.owner && view.owner.displayName) || '';

			let columns = (view.columns || []).filter(c => !(c.fieldName || '').startsWith(':'));
			let isGeo = view.viewType === 'geo' || view.displayType === 'map'
				|| columns.some(c => GEOMETRY_TYPES.has(c.dataTypeName));
			let type;
			if (!view.assetType || view.assetType === 'dataset') {
				type = isGeo ? 'Geospatial dataset' : 'Tabular dataset';
			}
			else {
				type = view.assetType.charAt(0).toUpperCase() + view.assetType.slice(1);
			}

			let dates = {
				dataUpdated: isoDate(view.rowsUpdatedAt),
				metadataUpdated: isoDate(view.viewLastModified),
				published: isoDate(view.publicationDate),
				created: isoDate(view.createdAt),
			};

			let license = view.license && (view.license.name || view.license.termsLink);
			let url = `${origin}/d/${view.id}`;

			let fields = {
				title: view.name,
				abstractNote: htmlToText(view.description),
				type,
				date: pickDate(dates, prefs.dateSource),
				repository: portal,
				url,
				rights: license || view.licenseId || '',
				extra: extraLines({ 'Dataset ID': view.id, Platform: 'Socrata' }),
			};

			let tags = unique([...(view.tags || []), view.category]);

			let rows = [
				['Portal', portal],
				['Platform', 'Socrata'],
				['Dataset ID', view.id],
				['Landing page', url, true],
				['Publisher / agency', author],
				['Data last updated', dates.dataUpdated],
				['Metadata last updated', dates.metadataUpdated],
				['First published', dates.published],
				['Created', dates.created],
				['Rows', rowCount !== null && rowCount !== undefined ? rowCount.toLocaleString('en-US') : ''],
				['Each row is', view.metadata && view.metadata.rowLabel],
				['SODA API endpoint', `${origin}/resource/${view.id}.json`, true],
				['CSV export', `${origin}/api/views/${view.id}/rows.csv?accessType=DOWNLOAD`, true],
				['License', license || view.licenseId],
				['Provenance', view.provenance],
			];
			for (let [group, entries] of Object.entries(custom)) {
				for (let [key, value] of Object.entries(entries || {})) {
					if (typeof value === 'string' && value) rows.push([`${group}: ${key}`, value]);
				}
			}

			let columnTable = '';
			if (columns.length) {
				columnTable = `<h2>Columns (${columns.length})</h2>\n<table>\n`
					+ '<tr><th>Name</th><th>API field</th><th>Type</th><th>Description</th></tr>\n'
					+ columns.map(c => '<tr>'
						+ `<td>${escapeHTML(c.name)}</td>`
						+ `<td><code>${escapeHTML(c.fieldName)}</code></td>`
						+ `<td>${escapeHTML(c.dataTypeName)}</td>`
						+ `<td>${escapeHTML(c.description)}</td>`
						+ '</tr>\n').join('')
					+ '</table>\n';
			}

			return {
				provider: 'socrata',
				url,
				fields,
				creators: author ? [{ name: author, creatorType: 'author' }] : [],
				tags,
				noteHTML: buildNote(view.name, rows, [columnTable]),
			};
		},
	};

	/** Socrata descriptions may contain HTML; abstracts should be plain text */
	function htmlToText(str) {
		if (!str) return '';
		return decodeEntities(String(str)
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|li)>/gi, '\n')
			.replace(/<[^>]+>/g, ''))
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	function findCustomField(custom, keyPattern) {
		for (let entries of Object.values(custom)) {
			for (let [key, value] of Object.entries(entries || {})) {
				if (keyPattern.test(key) && typeof value === 'string' && value.trim()) {
					return value.trim();
				}
			}
		}
		return '';
	}

	function decodeEntities(str) {
		return str
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
			.replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
	}

	// ------------------------------------------------------------------------
	// CKAN (data.boston.gov, open.canada.ca/data, many national/EU portals)
	// API: {base}/api/3/action/package_show?id={name}
	// ------------------------------------------------------------------------

	const ckan = {
		id: 'ckan',
		label: 'CKAN',

		/** Accepts {base}/dataset/{name}[/resource/...], where base may include a path and locale */
		match(input) {
			let url = parseURL(input);
			if (!url) return null;
			let segments = url.pathname.split('/');
			let i = segments.indexOf('dataset');
			if (i === -1 || !segments[i + 1]) return null;
			let prefix = segments.slice(0, i).join('/');
			let name = decodeURIComponent(segments[i + 1]);
			// The UI path may carry a locale (/data/en/dataset/x); the API usually doesn't
			let apiBases = [url.origin + prefix];
			let withoutLocale = prefix.replace(/\/[a-z]{2}(?:[-_][A-Za-z]{2})?$/, '');
			if (withoutLocale !== prefix) apiBases.push(url.origin + withoutLocale);
			return { origin: url.origin, host: url.host, name, pageBase: url.origin + prefix, apiBases };
		},

		async fetch(match, ctx) {
			let lastError;
			for (let apiBase of match.apiBases) {
				try {
					let res = await ctx.fetchJSON(
						`${apiBase}/api/3/action/package_show?id=${encodeURIComponent(match.name)}`
					);
					if (!res || !res.success || !res.result) {
						throw new Error('CKAN package_show failed');
					}
					let portal = await this.portalName(apiBase, match.host, ctx);
					return ckan.toRecord(res.result, { ...match, portal }, ctx.prefs || {});
				}
				catch (e) {
					lastError = e;
				}
			}
			throw lastError || new Error(`Not a CKAN dataset: ${match.name}`);
		},

		async portalName(apiBase, host, ctx) {
			if (portalNameCache.has(apiBase)) return portalNameCache.get(apiBase);
			let name = '';
			try {
				let res = await ctx.fetchJSON(`${apiBase}/api/3/action/status_show`);
				name = (res && res.result && res.result.site_title) || '';
			}
			catch (e) {}
			if (!name) name = host;
			portalNameCache.set(apiBase, name);
			return name;
		},

		/** Pure mapping from package_show JSON to a record (exported for tests) */
		toRecord(pkg, { pageBase, portal }, prefs) {
			let lang = (prefs.language || 'en').slice(0, 2);
			let title = localized(pkg.title_translated, lang) || pkg.title || pkg.name;
			let notes = localized(pkg.notes_translated, lang) || pkg.notes || '';
			let org = pkg.organization && pkg.organization.title;
			// Bilingual portals (e.g. open.canada.ca) title organizations "English | Français"
			if (org && pkg.title_translated && org.includes(' | ')) {
				let parts = org.split(' | ');
				org = (lang === 'fr' && parts[1]) || parts[0];
			}
			let author = org || pkg.author || pkg.publisher || pkg.maintainer || '';
			let resources = pkg.resources || [];

			let resourceDates = resources.map(r => r.last_modified || r.metadata_modified).filter(Boolean).sort();
			let dates = {
				dataUpdated: isoDate(resourceDates[resourceDates.length - 1]) || isoDate(pkg.metadata_modified),
				metadataUpdated: isoDate(pkg.metadata_modified),
				published: isoDate(pkg.issued || pkg.metadata_created),
				created: isoDate(pkg.metadata_created),
			};

			let formats = unique(resources.map(r => (r.format || '').trim().toUpperCase()));
			let url = `${pageBase}/dataset/${pkg.name}`;
			let doi = findDOI(pkg);

			let fields = {
				title,
				abstractNote: notes.replace(/\r\n/g, '\n').trim(),
				type: 'Dataset',
				versionNumber: pkg.version || '',
				date: pickDate(dates, prefs.dateSource),
				repository: portal,
				url,
				rights: pkg.license_title || pkg.license_id || '',
				DOI: doi,
				language: typeof pkg.language === 'string' ? pkg.language : '',
				extra: extraLines({ 'Dataset ID': pkg.name, Platform: 'CKAN', Formats: formats.join(', ') }),
			};

			let keywords = pkg.keywords && typeof pkg.keywords === 'object' && !Array.isArray(pkg.keywords)
				? pkg.keywords[lang] || pkg.keywords.en || []
				: [];
			let tags = unique([
				...(pkg.tags || []).map(t => t.display_name || t.name),
				...keywords,
				...(pkg.groups || []).map(g => g.display_name || g.title || g.name),
			]);

			let rows = [
				['Portal', portal],
				['Platform', 'CKAN'],
				['Dataset ID', pkg.name],
				['Formats', formats.join(', ')],
				['Landing page', url, true],
				['Organization', org],
				['Author', pkg.author],
				['Maintainer', pkg.maintainer],
				['Publisher', typeof pkg.publisher === 'string' ? pkg.publisher : ''],
				['Data last updated', dates.dataUpdated],
				['Metadata last updated', dates.metadataUpdated],
				['Created', dates.created],
				['Update frequency', pkg.accrual_periodicity || pkg.frequency],
				['Version', pkg.version],
				['License', pkg.license_title],
				['Source URL', pkg.url, true],
			];

			let resourceTable = '';
			if (resources.length) {
				resourceTable = `<h2>Resources (${resources.length})</h2>\n<table>\n`
					+ '<tr><th>Name</th><th>Format</th><th>Last modified</th></tr>\n'
					+ resources.map(r => {
						let label = escapeHTML(r.name || r.url || r.id);
						let link = r.url ? `<a href="${escapeHTML(r.url)}">${label}</a>` : label;
						return `<tr><td>${link}</td><td>${escapeHTML(r.format)}</td>`
							+ `<td>${escapeHTML(isoDate(r.last_modified || r.metadata_modified))}</td></tr>\n`;
					}).join('')
					+ '</table>\n';
			}

			return {
				provider: 'ckan',
				url,
				fields,
				creators: author ? [{ name: author, creatorType: 'author' }] : [],
				tags,
				noteHTML: buildNote(title, rows, [resourceTable]),
			};
		},
	};

	/** Pick a language from a CKAN {en: ..., fr: ...} translation object */
	function localized(value, lang) {
		if (!value || typeof value !== 'object') return '';
		return value[lang] || value.en || Object.values(value).find(Boolean) || '';
	}

	function findDOI(pkg) {
		let candidates = [pkg.doi, pkg.DOI];
		for (let extra of pkg.extras || []) {
			if (/doi/i.test(extra.key)) candidates.push(extra.value);
		}
		for (let c of candidates) {
			let m = typeof c === 'string' && c.match(/10\.\d{4,9}\/\S+/);
			if (m) return m[0];
		}
		return '';
	}

	// ------------------------------------------------------------------------

	const PROVIDERS = [socrata, ckan];

	/** Providers whose URL pattern matches, in priority order */
	function candidates(input) {
		return PROVIDERS
			.map(provider => ({ provider, match: provider.match(input) }))
			.filter(c => c.match);
	}

	function canHandle(input) {
		return candidates(input).length > 0;
	}

	/**
	 * Resolve a URL to a record. Patterns overlap (a CKAN slug like
	 * "roads-2024" looks like a Socrata 4x4 ID), so each matching provider is
	 * tried in turn and the first that the portal's API confirms wins.
	 */
	async function resolve(input, ctx) {
		let matches = candidates(input);
		if (!matches.length) {
			throw new Error(`Unrecognized open data URL: ${input}`);
		}
		let errors = [];
		for (let { provider, match } of matches) {
			try {
				return await provider.fetch(match, ctx);
			}
			catch (e) {
				errors.push(`${provider.label}: ${e.message || e}`);
			}
		}
		throw new Error(`Couldn't read dataset metadata from ${input} (${errors.join('; ')})`);
	}

	return {
		PROVIDERS, socrata, ckan, canHandle, resolve, isoDate, escapeHTML,
		_clearCache: () => portalNameCache.clear(),
	};
})();

if (typeof module !== 'undefined') {
	module.exports = OpenDataProviders;
}
