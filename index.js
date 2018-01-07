module.exports = function (serverPath, opts) {
	const path = require('path')
	const fs = require('fs')
	const url = require('url')
	const bs = require('browser-sync').create()
	const less = require('less')
	const autoprefixer = require('autoprefixer')({browsers: ['last 2 versions', 'safari >= 8', 'ie >= 11']})
	const flexfix = require('postcss-flexbugs-fixes')
	const postcss = require('postcss')
	const marked = require('marked').setOptions({smartypants: true})
	const rollup = require('rollup').rollup
	const json = require('rollup-plugin-json')
	const replace = require('rollup-plugin-re')
	const commonjs = require('rollup-plugin-commonjs')
	const nodeResolve = require('rollup-plugin-node-resolve')
	const builtins = require('rollup-plugin-node-builtins')
	const globals = require('rollup-plugin-node-globals')
	const nodent = require('rollup-plugin-nodent')
	const buble = require('rollup-plugin-buble')
	const CACHE = {}
	const watcherOpts = {
		ignoreinitial: false,
		ignored: ['vendor', 'node_modules', 'bower_components', 'build']
	}

	function resolveFilePath(fileName, parentName) {
		let dir = path.dirname(parentName)
		if (fileName.match(/^\/\w/)) {
			dir = serverPath
		}
		fileName = path.join(dir, fileName)
		if (!path.extname(fileName)) {
			return path.join(fileName, 'index.html')
		}
		return fileName
	}
	function replaceMatch(match, newContent, groupIndex) {
		const raw = match[0]
		const content = match[groupIndex || 0]
		const input = match.input
		const index = match.index
		const pre = input.substring(0, index)
		const pos = input.substring(index + raw.length)

		// Replace through fn to avoid $n substitution
		return pre + raw.replace(content, () => newContent) + pos
	}
	function adjustFilePaths(vFile) {
		const links = /<[\w-]+ +.*?(?:src|href)=['"]?(.+?)['">\s]/g
		return new Promise(resolve => {
			vFile.source = vFile.source.replace(links, (m, src) => {
				src = src.trim()
				if (!src || src.match(/^(\w+:|#|\/|\$)/)) {
					return m
				}
				const resolved = resolveFilePath(src, vFile.path)
				return m.replace(src, resolved)
			})
			resolve(vFile)
		})
	}
	function readFile(filePath) {
		return new Promise((resolve, reject) => {
			function onFile(err, contents) {
				if (err) {
					return reject(err.message)
				}
				if (path.extname(filePath).match(/\.(md|markdown|mdown)/)) {
					contents = marked(contents.toString())
				}
				const vFile = {path: filePath, source: contents.toString()}
				const cachedFile = CACHE[filePath]
				// RETRIEVE PARENT FROM CACHE
				if (cachedFile && cachedFile.parentPath) {
					vFile.parentPath = cachedFile.parentPath
				}
				resolve(vFile)
			}
			fs.readFile(filePath, onFile)
		})
	}
	function getElementType(attrs) {
		attrs = attrs || ''
		const match = attrs.match(/\btype=["']?\w+\/(\w+)\b["']?/)
		return match && match[1]
	}

	function outputStyleError(msg, filePath) {
		return '' +
			'html:before, :host:before {' +
			'  content: "STYLE ERROR: ' + msg + ' (' + filePath + ')";' +
			'  position: fixed;' +
			'  font: 1em/1.5 sans-serif;' +
			'  top: 0;' +
			'  left: 0;' +
			'  right: 0;' +
			'  padding: 1em;' +
			'  text-align: left;' +
			'  white-space: pre;' +
			'  color: white;' +
			'  background-color: tomato;' +
			'  z-index: 10000' +
			'}'
	}
	function outputJSError(msg) {
		const error = msg
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
		return 'console.error("' + error + '");'
	}

	function replaceEnvVars(vFile) {
		const pattern = /(?:\$ENV|process\.env)\[['"]?([\w.\-/@]+?)['"]?\]/g
		const nodePattern = /process.env(?:\.(.+?)\b|\[(["'])(.+?)\2\])/g
		return new Promise(resolve => {
			vFile.source = vFile.source.replace(pattern, (_, v) => {
				return process.env[v] || ''
			}).replace(nodePattern, (m, v1, _, v3) => {
				return `'${process.env[v1 || v3] || ''}'`
			})
			resolve(vFile)
		})
	}
	function replaceNodeEnvVars() {
		return replace({
			patterns: [{
				test: /process.env(?:\.(.+?)\b|\[(["'])(.+?)\2\])/g,
				replace: (m, v1, _, v3) => JSON.stringify(process.env[v1 || v3] || '')
			}]
		})
	}
	function replaceSSI(vFile) {
		// More http://www.w3.org/Jigsaw/Doc/User/SSI.html#include
		const pattern = /<!--#include file=["']?(.+?)["']? -->/g
		return new Promise(resolve => {
			function check(match) {
				if (!match) {
					return resolve(vFile)
				}
				readFile(resolveFilePath(match[1], vFile.path))
					.then(adjustFilePaths)
					.then(processHTML)
				// .then(processInlineScripts)
				// .then(replaceSSI)
				// .then(replaceEnvVars)
					.then($vFile => {
						vFile.source = replaceMatch(match, $vFile.source)
						check(pattern.exec(vFile.source))

						// UPDATE CACHED VERSION POINTING PARENT FILE
						$vFile.parentPath = vFile.path
						CACHE[$vFile.path] = $vFile

						return vFile
					})
					.catch(err => {
						vFile.source = vFile.source.replace(match[0], () => err)
						check(pattern.exec(vFile.source))
					})
			}
			check(pattern.exec(vFile.source))
		})
	}

	function autoprefixCSS(vFile) {
		return new Promise((resolve, reject) => {
			try {
				const post = postcss([flexfix, autoprefixer])
					.process(vFile.source, {
						from: path.basename(vFile.path),
						map: true
					})
				if (post.warnings) {
					post.warnings().forEach(warn => {
						console.warn('POSTCSS', warn.toString())
					})
				}
				vFile.source = post.css
				resolve(vFile)
			} catch (err) {
				vFile.source = err.message
				vFile.error = true
				reject(vFile)
			}
		})
	}
	function lessify(vFile) {
		return new Promise((resolve, reject) => {
			less.render(vFile.source, {
				filename: vFile.path,
				relativeUrls: true,
				sourceMap: {
					outputSourceFiles: true,
					sourceMapBasepath: serverPath,
					sourceMapFileInline: true
				}
			}).then(out => {
				vFile.source = out.css
				resolve(vFile)
			}).catch(err => {
				vFile.error = true
				vFile.source = err.message
				reject(vFile)
			})
		})
	}
	function processStyle(vFile) {
		const ext = path.extname(vFile.path)
		let promise = Promise.resolve(vFile)
		if (ext === '.less') {
			promise = lessify(vFile)
		}
		return promise
			.then(autoprefixCSS)
			.then(metaFile => {
				metaFile.mimeType = 'text/css'
				return metaFile
			})
			.catch(err => {
				err.source = JSON.stringify(err.source, null, 4)
					.replace(/\n/g, '\\A')
					.replace(/"/g, '\\"')
				err.source = outputStyleError(err.source, err.path)
				return err
			})
	}

	/*
	Function groupLinkTags(vFile) {
		var tags = /<link .*(?:src|href)=['"]?([\w\.]+)['"]?.*>/g,
			head = /(<\/title>|<meta .*>)|(<\/head>|<body|<script)/,
			links = [];
		vFile.source = vFile.source.replace(tags, function (m) {
			if (links.indexOf(m) === -1) { links.push(m); }
			return '';
		});
		links = links.join('\n');
		vFile.source = vFile.source.replace(head, function (m, after) {
			if (after) {
				m += '\n' + links;
			} else {
				m = links + '\n' + m;
			}
			return m;
		});
		return vFile;
	}
	function mergeInlineScripts(vFile) {
		var tags = /<(script)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
			scripts = [];
		vFile.source = vFile.source.replace(tags, function (m, t, a, content) {
			if (content) {
				content = '(function () { ' + content + '}());';
				if (scripts.indexOf(content) === -1) {
					scripts.push(content);
				}
				return '';
			}
			return m;
		});
		vFile.source += '<script>' + scripts.join('\n\n') + '</script>';
		return vFile;
	}
	*/

	function virtualInput(file) {
		return {
			name: 'rollup-plugin-virtual-input',
			load: id => {
				if (file.path === id) {
					return file.source
				}
			},
			resolveId: id => {
				if (file.path === id) {
					return file.path
				}
			}
		}
	}
	function fmtBundleName(filename) {
		filename = filename.replace(/\.js$/, '')
		const paths = filename.split(/[/\-_]/)
		return paths.reduce((p, c, index) => {
			if (index > 0) {
				c = c.replace(/./, m => m.toUpperCase())
			}
			p += c
			return p
		}, '')
	}
	function transpile(file) {
		return rollup({
			input: file.path,
			plugins: [
				virtualInput(file),
				json(),
				nodeResolve({
					preferBuiltins: true,
					browser: true,
					jsnext: true,
					extensions: ['.js', '.json']
				}),
				commonjs(),
				builtins(),
				replaceNodeEnvVars(),
				nodent({promises: true, noRuntime: true}),
				buble(),
				globals()
			]
		})
			.then(bundle => {
				return bundle.generate({
					name: fmtBundleName(file.path),
					format: 'iife',
					sourcemap: true
				})
			})
			.then(bundle => {
				file.source =
					bundle.code +
					'\n\n//# sourceMappingURL=data:application/json;charset=utf8;base64,' +
					Buffer.from(JSON.stringify(bundle.map)).toString('base64') + '\n'
				return file
			})
	}

	function hasExports(contents) {
		const pattern = /^\s*(module\.exports|exports\.|export )/gm
		return pattern.test(contents)
	}
	function processJS(vFile) {
		if (hasExports(vFile.contents)) {
			return Promise.resolve(vFile)
		}
		return transpile(vFile).catch(err => {
			vFile.source = outputJSError(err.message)
			return vFile
		})
	}

	function processInlineScripts(vFile) {
		const stylePattern = /<(style)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi
		const scriptPattern = /<(script)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi
		const vPath = path.parse(vFile.path)
		const queue = []

		function replaceTags(match, tag, attrs, content, index) {
			// SKIP EMPTY TAGS
			if (!content.trim()) {
				return match
			}
			const format = getElementType(attrs) || (tag === 'script' ? 'js' : 'css')
			const iFile = {
				type: tag,
				path: path.join(vPath.dir, `${vPath.name}_${tag}_${index}.${format}`),
				source: content
			}
			// REMOVE LESS TYPE ONCE CONVERTED
			const nAttrs = attrs.replace('type=text/less', '')
			// SKIP TRANSPILING LD+JSON SCRIPTS
			if (content && attrs.match(/application\/ld\+json/)) {
				return match
			}
			queue.push(iFile)
			return match
				.replace(attrs, nAttrs)
				.replace(content, '@{' + iFile.path + '}')
		}
		function next(iFile) {
			return new Promise(resolve => {
				if (!iFile) {
					return resolve(vFile)
				}
				const p = iFile.type === 'style' ? processStyle(iFile) : processJS(iFile)
				p.then(mFile => {
					vFile.source = vFile.source.replace(`@{${iFile.path}}`, () => {
						return mFile.source
					})
					resolve(next(queue.shift()))
				})
			})
		}

		vFile.source = vFile.source.replace(stylePattern, replaceTags)
		vFile.source = vFile.source.replace(scriptPattern, replaceTags)
		return next(queue.shift())
	}
	function processHTML(vFile) {
		return replaceSSI(vFile)
			.then(replaceEnvVars)
		// .then(mergeInlineScripts)
		// .then(groupLinkTags)
			.then(processInlineScripts)
	}

	function getDiff(a, b) {
		const styles = /(<style\b[^>]*>[\s\S]*?<\/style>?)|(<script\b[^>]*>[\s\S]*?<\/script>?)/
		const contentMatch = /<style\b([^>]*)>([\s\S]*?)<\/style>|<script\b[^>]*>([\s\S]*?)<\/script>?/
		const changes = []
		const linesA = a.split(styles).filter(i => i)
		const linesB = b.split(styles).filter(i => i)

		function setChangeType(line) {
			if (!line) {
				return
			}
			let type
			if (line.match('<script')) {
				type = 'script'
			} else if (line.match('<style')) {
				type = 'style'
			} else {
				type = 'dom'
			}
			return type
		}
		function getAttributesFromLine(line) {
			if (!line) {
				return
			}
			const match = line.match(contentMatch)
			return match && (match[1] || match[3])
		}
		function getSourceFromLine(line) {
			if (!line) {
				return
			}
			const match = line.match(contentMatch)
			return match && (match[2] || match[4])
		}

		function addTypeToChanges(type) {
			if (!changes.type) {
				changes.type = type
			}
			if (changes.type !== type) {
				changes.type = 'mixed'
			}
			return type
		}

		function checkChanges(_, index) {
			const original = linesA[index]
			const newContent = linesB[index]

			if (newContent !== original) {
				const type = setChangeType(original) || setChangeType(newContent)

				addTypeToChanges(type)

				changes.push({
					type,
					was: original,
					became: newContent,
					attributes: getAttributesFromLine(newContent),
					source: getSourceFromLine(newContent)
				})
			}
		}

		// Always analyse the side with more lines
		Array(Math.max(linesA.length, linesB.length))
			.fill().forEach(checkChanges)

		return changes
	}
	function cachefy(vFile) {
		const broadcast = vFile.broadcast
		delete vFile.broadcast
		if (vFile.error) {
			console.error('FOUND ERROR:', vFile)
		}
		CACHE[vFile.path] = vFile
		return Boolean(broadcast)
	}

	function broadcastChanges(vFile) {
		if (!CACHE[vFile.path]) {
			return vFile
		}
		const changes = getDiff(CACHE[vFile.path].source, vFile.source)

		if (changes.length === 0) {
			vFile.broadcast = true
		}
		if (changes.type === 'style') {
			const format = getElementType(changes[0].attributes) || 'css'
			return processStyle({
				path: vFile.path.replace('.html', '.' + format),
				source: changes[0].source
			}).then(nFile => {
				this.sockets.emit('css', nFile)
				vFile.broadcast = true
				return vFile
			})
		}
		return vFile
	}
	function onHTMLChange(_eventName, filePath) {
		readFile(filePath)
			.then(processHTML)
			.then(broadcastChanges.bind(this))
			.then(cachefy)
			.then(isBroadcast => {
				if (!isBroadcast) {
					const parentPath = CACHE[filePath].parentPath
					if (parentPath) {
						// IF PARENT FILE, PROCESS PARENT
						return onHTMLChange.bind(this)(null, parentPath)
					}
					// WHEN NO MORE PARENT, RELOAD TOPMOST FILE
					this.reload(filePath)
				}
			})
			.catch(console.error)
	}
	function onJSChange(eventName, filePath) {
		readFile(filePath)
			.then(processJS)
			.then(cachefy)
			.then(() => this.reload(filePath))
	}
	function onStyleChange(eventName, filePath) {
		readFile(filePath)
			.then(processStyle)
			.then(cachefy)
			.then(() => this.reload(filePath))
	}

	const config = {
		browser: 'google chrome',
		open: false,
		online: false,
		notify: false,
		minify: false,
		server: serverPath,
		files: [
			{
				options: watcherOpts,
				match: ['**/*.html'],
				fn: onHTMLChange
			},
			{
				options: watcherOpts,
				match: ['**/*.js'],
				fn: onJSChange
			},
			{
				options: watcherOpts,
				match: ['**/*.{css,less}'],
				fn: onStyleChange
			}
		],
		injectFileTypes: ['css', 'less'],
		middleware(req, res, next) {
			const filePath = url.parse(req.url).pathname.replace(/\/$/, '/index.html')
			const fileSrc = path.join(serverPath, filePath)
			const fileExt = path.extname(fileSrc) ? path.extname(fileSrc) : '.html'
			const isDependency = filePath.match(/bower_components|node_modules/)
			const isXHR = req.headers['x-requested-with'] === 'XMLHttpRequest'
			let cachedVersion = CACHE[fileSrc]

			if (opts['single-page'] && !cachedVersion && fileExt === '.html') {
				try {
					fs.statSync(fileSrc)
				} catch (err) {
					cachedVersion = CACHE[opts['single-page']]
				}
			}
			if (isXHR || isDependency || !cachedVersion) {
				return next()
			}

			if (cachedVersion.mimeType) {
				res.setHeader('content-type', cachedVersion.mimeType)
			}
			res.writeHead(200)
			return res.end(cachedVersion.source)
		},
		snippetOptions: {
			rule: {
				match: /$/,
				fn(snippet) {
					return snippet
				}
			}
		}
	}

	if (opts.port) {
		config.port = opts.port
	}
	if (opts.ssl) {
		console.log('SETTING HTTPS USING CUSTOM CERTIFICATE')
		console.log(`LOOKING AT ${opts.ssl}.key and ${opts.ssl}.crt`)
		config.https = {
			key: path.resolve(opts.ssl + '.key'),
			cert: path.resolve(opts.ssl + '.crt')
		}
	}

	bs.init(config)
}
