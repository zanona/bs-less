/*eslint indent:[1,4]*/
module.exports = function (serverPath) {
    'use strict';

    var path         = require('path'),
        fs           = require('fs'),
        url          = require('url'),
        stream       = require('stream'),
        bs           = require('browser-sync').create(),
        less         = require('less'),
        autoprefixer = require('autoprefixer-core'),
        browserify   = require('browserify'),
        regenerator  = require('regenerator'),
        babel        = require('babel-core'),
        babelify     = require('babelify'),
        es2015       = require('babel-preset-es2015'),
        postcss      = require('postcss'),
        marked       = require('marked').setOptions({smartypants: true}),
        CACHE        = {};

    function resolveFilePath(fileName, parentName) {
        var dir = path.dirname(parentName);
        fileName = path.join(dir, fileName);
        if (!path.extname(fileName)) {
            return path.join(fileName, 'index.html');
        }
        return fileName;
    }
    function replaceMatch(match, newContent, groupIndex) {
        const raw = match[0],
            content = match[groupIndex || 0],
            input = match.input,
            index = match.index,
            pre = input.substring(0, index),
            pos = input.substring(index + raw.length);

        //replace through fn to avoid $n substitution
        return pre + raw.replace(content, () => newContent) + pos;
    }
    function adjustFilePaths(vFile) {
        var links = /(?:src|href)=['"]?(.+?)['">\s]/g,
            requires = /require\(['"](\..*?)['"]\)/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(links, function (m, src) {
                if (src.match(/^(\w+:|#|\/)/)) { return m; }
                var resolved = resolveFilePath(src, vFile.path);
                return m.replace(src, resolved);
            }).replace(requires, function (m, src) {
                var resolved = './' + resolveFilePath(src, vFile.path)
                    .replace('/index.html', '');
                return m.replace(src, resolved);
            });
            resolve(vFile);
        });
    }
    function readFile(filePath) {
        return new Promise(function (resolve, reject) {
            function onFile(err, contents) {
                if (err) { return reject(err.message); }
                if (path.extname(filePath).match(/\.(md|mardown|mdown)/)) {
                    contents = marked(contents.toString());
                }
                resolve({
                    path: filePath,
                    source: contents.toString()
                });
            }
            fs.readFile(filePath, onFile);
        });
    }
    function getElementType(attrs) {
        attrs = attrs || '';
        const match = attrs.match(/\btype=["']?\w+\/(\w+)\b["']?/);
        return match && match[1];
    }

    function outputStyleError(msg) {
        return ''
            + 'root:before, :host:before {'
            + '  content: "STYLE ERROR: ' + msg + '";'
            + '  position: fixed;'
            + '  font: 1em/1.5 monospace'
            + '  top: 0;'
            + '  left: 0;'
            + '  right: 0;'
            + '  padding: 1em;'
            + '  text-align: left;'
            + '  white-space: pre;'
            + '  color: white;'
            + '  background-color: tomato;'
            + '  z-index: 10000'
            + '}';
    }
    function outputJSError(msg) {
        var error = msg
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
        return 'console.error("' + error  + '");';
    }

    function replaceEnvVars(vFile) {
        var pattern = /\$ENV\[['"]?([\w\.\-\/@]+?)['"]?\]/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(pattern, function (_, v) {
                return process.env[v] || '';
            });
            resolve(vFile);
        });
    }
    function replaceSSI(vFile) {
        // more http://www.w3.org/Jigsaw/Doc/User/SSI.html#include
        var pattern = /<!--#include file=[\"\']?(.+?)[\"\']? -->/g;
        return new Promise(function (resolve) {
            function check (match) {
                if (!match) { return resolve(vFile); }
                readFile(resolveFilePath(match[1], vFile.path))
                    .then(adjustFilePaths)
                    //.then(processInlineScripts)
                    .then(replaceSSI)
                    .then(replaceEnvVars)
                    .then(function ($vFile) {
                        vFile.source = replaceMatch(match, $vFile.source);
                        check(pattern.exec(vFile.source));
                        return vFile;
                    })
                    .catch(function (e) {
                        vFile.source = vFile.source
                        .replace(match[0], function () { return e; });
                        check(pattern.exec(vFile.source));
                    });
            }
            check(pattern.exec(vFile.source));
        });
    }

    function autoprefixCSS(vFile) {
        return new Promise((resolve, reject) => {
            try {
                const post = postcss([autoprefixer])
                    .process(vFile.source, {
                        from: path.basename(vFile.path),
                        map: true
                    });
                if (post.warnings) {
                    post.warnings().forEach(function (warn) {
                        console.warn('POSTCSS', warn.toString());
                    });
                }
                vFile.source = post.css;
                resolve(vFile);
            } catch (e) {
                vFile.source = e.message;
                vFile.error = true;
                reject(vFile);
            }
        });
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
            }).then((out) => {
                vFile.source = out.css;
                resolve(vFile);
            }).catch((e) => {
                vFile.error = true;
                vFile.source = e.message;
                reject(vFile);
            });
        });
    }
    function processStyle(vFile) {
        var ext = path.extname(vFile.path),
            promise = new Promise((r) => r(vFile));
        if (ext === '.less') { promise = lessify(vFile); }
        return promise
            .then(autoprefixCSS)
            .then((metaFile) => {
                metaFile.mimeType = 'text/css';
                return metaFile;
            })
            .catch(function (errorFile) {
                errorFile.source = JSON.stringify(errorFile.source, null, 4)
                   .replace(/\n/g, '\\A')
                   .replace(/"/g, '\\"');
                errorFile.source = outputStyleError(errorFile.source);
                return errorFile;
            });
    }

    /*
    function groupLinkTags(vFile) {
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

    function regenerate(vFile) {
        return new Promise((resolve, reject) => {
            try {
                vFile.source = regenerator.compile(vFile.source).code;
                resolve(vFile);
            } catch (e) {
                reject({
                    error: true,
                    path: vFile.path,
                    source: e.message
                });
            }
        });
    }
    function babelPromise(vFile) {
        return new Promise((resolve, reject) => {
            try {
                vFile.source = babel.transform(vFile.source, {
                    filename: vFile.path,
                    presets: [es2015]
                }).code;
                resolve(vFile);
            } catch (e) {
                reject({
                    error: true,
                    path: vFile.path,
                    source: e.message
                });
            }
        });
    }
    function browserifyPromise(vFile) {
        return new Promise(function (resolve, reject) {
            const moduleMatch = /^(?:[ \t]*)?(?:import|export)\b|\brequire\(/gm;
            if (!vFile.source.match(moduleMatch)) {
                return resolve(vFile); }
            var src = new stream.Readable();
            src.push(vFile.source);
            src.push(null);
            src.file = vFile.path;
            browserify(src, {debug: true})
                .transform(regenerator)
                .transform(babelify, {
                    filename: vFile.path,
                    presets: [es2015]
                })
                .bundle(function (err, bundle) {
                    if (err) {
                        return reject({
                            error: true,
                            path: vFile.path,
                            source: err.message
                        });
                    }
                    resolve({
                        path: vFile.path,
                        source: bundle.toString()
                    });
                });
        });
    }
    function processJS(vFile) {
        return regenerate(vFile)
            .then(browserifyPromise)
            .then(babelPromise)
            .then(replaceEnvVars)
            .catch(function (errorFile) {
                errorFile.source = outputJSError(errorFile.source);
                return errorFile;
            });
    }

    function processInlineScripts(vFile) {
        var stylePattern = /<(style)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi,
            scriptPattern = /<(script)\b([^>]*)>([\s\S]*?)<\/\1>?/gmi,
            vPath = path.parse(vFile.path),
            queue = [];

        function replaceTags(match, tag, attrs, content, index) {
            const format = getElementType(attrs) || (tag === 'script' ? 'js' : 'css'),
                iFile = {
                    type: tag,
                    path: path.join(vPath.dir, `${vPath.name}_${tag}_${index}.${format}`),
                    source: content
                };
            queue.push(iFile);
            return match.replace(content, '@{' + iFile.path + '}');
        }
        function next(iFile) {
            return new Promise((resolve) => {
                if (!iFile) { return resolve(vFile); }
                const p = iFile.type === 'style' ? processStyle(iFile) : processJS(iFile);
                p.then((mFile) => {
                    vFile.source = vFile.source.replace(`@{${iFile.path}}`, () => {
                        return mFile.source;
                    });
                    resolve(next(queue.shift()));
                });
            });
        }

        vFile.source = vFile.source.replace(stylePattern, replaceTags);
        vFile.source = vFile.source.replace(scriptPattern, replaceTags);
        return next(queue.shift());
    }
    function processHTML(vFile) {
        return replaceSSI(vFile)
            .then(replaceEnvVars)
            //.then(mergeInlineScripts)
            //.then(groupLinkTags)
            .then(processInlineScripts);
    }

    function getDiff(a, b) {
        const styles = /(<style\b[^>]*>[\s\S]*?<\/style>?)|(<script\b[^>]*>[\s\S]*?<\/script>?)/,
            contentMatch = /<style\b([^>]*)>([\s\S]*?)<\/style>|<script\b[^>]*>([\s\S]*?)<\/script>?/,
            changes = [],
            linesA  = a.split(styles).filter((i) => i),
            linesB  = b.split(styles).filter((i) => i);

        function setChangeType(line) {
            if (!line) { return; }
            let type;
            if (line.match('<script')) {
                type = 'script';
            } else if (line.match('<style')) {
                type = 'style';
            } else {
                type = 'dom';
            }
            return type;
        }
        function getAttributesFromLine(line) {
            if (!line) { return; }
            var match = line.match(contentMatch);
            return match && (match[1] || match[3]);
        }
        function getSourceFromLine(line) {
            if (!line) { return; }
            var match = line.match(contentMatch);
            return match && (match[2] || match[4]);
        }

        function addTypeToChanges(type) {
            if (!changes.type) changes.type = type;
            if (changes.type !== type) changes.type = 'mixed';
            return type;
        }

        function checkChanges(_, index) {
            const original = linesA[index],
                newContent = linesB[index];

            if(newContent !== original) {
                const type = setChangeType(original) || setChangeType(newContent);

                addTypeToChanges(type);

                changes.push({
                    type,
                    was: original,
                    became: newContent,
                    attributes: getAttributesFromLine(newContent),
                    source: getSourceFromLine(newContent)
                });
            }
        }

        //Always analyse the side with more lines
        Array(Math.max(linesA.length,linesB.length))
          .fill().forEach(checkChanges);

        return changes;
    }
    function cachefy(vFile) {
        const broadcast = vFile.broadcast;
        delete vFile.broadcast;
        if (vFile.error) { console.error('FOUND ERROR:', vFile); }
        CACHE[vFile.path] = vFile;
        return !!broadcast;
    }

    function broadcastChanges(vFile) {
        if (!CACHE[vFile.path]) { return vFile; }
        const changes = getDiff(CACHE[vFile.path].source, vFile.source);

        if (!changes.length) { vFile.broadcast = true; }
        if (changes.type === 'style') {
            const format = getElementType(changes[0].attributes) || 'css';
            return processStyle({
                path: vFile.path.replace('.html', '.' + format),
                source: changes[0].source
            }).then((nFile) => {
                this.sockets.emit('css', nFile);
                vFile.broadcast = true;
                return vFile;
            });
        }
        return vFile;
    }
    function onHTMLChange(eventName, filePath) {
        readFile(filePath)
            .then(processHTML)
            .then(broadcastChanges.bind(this))
            .then(cachefy)
            .then((isBroadcast) => {
                if (!isBroadcast) { this.reload(filePath); }
            })
            .catch(console.error);
    }
    function onJSChange(eventName, filePath) {
        readFile(filePath)
            .then(processJS)
            .then(cachefy)
            .then(() => this.reload(filePath));
    }
    function onStyleChange(eventName, filePath) {
        readFile(filePath)
            .then(processStyle)
            .then(cachefy)
            .then(() => this.reload(filePath));
    }

    bs.init({
        browser: 'google chrome',
        open: false,
        online: false,
        notify: false,
        minify: false,
        server: serverPath,
        files: [
            {
                options: { ignoreInitial: false },
                match: [
                    serverPath + '*.html',
                    serverPath + 'lib/*.html',
                    serverPath + 'lib/**.html'
                ],
                fn: onHTMLChange
            },
            {
                options: { ignoreInitial: false },
                match: [
                    serverPath + '*.js',
                    serverPath + 'scripts/*.js',
                    serverPath + 'lib/*.js',
                    serverPath + 'lib/*/*.js'
                ],
                fn: onJSChange
            },
            {
                options: { ignoreInitial: false },
                match: [
                    serverPath + '*.{css,less}',
                    serverPath + 'lib/*.{css,less}',
                    serverPath + 'lib/*/*.{css,less}'
                ],
                fn: onStyleChange
            }
        ],
        injectFileTypes: ['css', 'less'],
        middleware: function (req, res, next) {

            var cURL = req.url.replace(/\/$/, '/index.html'),
                filePath = url.parse(cURL).pathname,
                fileSrc = path.join(serverPath, filePath),
                cachedVersion = CACHE[fileSrc],
                isDependency = filePath.match(/bower_components|node_modules/),
                isXHR = req.headers['x-requested-with'] === 'XMLHttpRequest';

            if (isXHR || isDependency || !cachedVersion) { return next(); }

            if (cachedVersion.mimeType) {
                res.setHeader('content-type', cachedVersion.mimeType);
            }
            res.writeHead(200);
            return res.end(cachedVersion.source);
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    });

};
