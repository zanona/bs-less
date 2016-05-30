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

    function outputStyleError(msg) {
        return ''
            + 'html:before {'
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

    function getStyleType(attrs) {
        attrs = attrs || '';
        const match = attrs.match(/\btype=["']?text\/(\w+)\b["']?/);
        return match && match[1] || 'css';
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
    function processInlineStyles(vFile) {
        var styles = /<(style)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            vPath = path.parse(vFile.path),
            vSource = vFile.source;

        return new Promise(function (resolve) {
            function check() {
                var styleMatch = styles.exec(vSource),
                    styleContent = styleMatch && styleMatch[3],
                    styleFormat,
                    inlineFile;

                if (!styleMatch)   { return resolve(vFile); }
                if (!styleContent) { return check(); }

                styleFormat = getStyleType(styleMatch[2]);
                inlineFile = {
                    path: path.join(
                        vPath.dir,
                        `${vPath.name}_style_${styleMatch.index}.${styleFormat}`
                    ),
                    source: styleContent
                };
                processStyle(inlineFile)
                    .then(function (iFile) {
                        vFile.source = replaceMatch(styleMatch, iFile.source, 3);
                        check();
                    })
                    .catch(function (errorFile) {
                        vFile.source = replaceMatch(
                            styleMatch,
                            outputStyleError(errorFile.source),
                            3
                        );
                        check();
                    });
            }
            check();
        });
    }

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
            const importMatch = /^(?:\s*)?import\b|\brequire\(/gm;
            if (!vFile.source.match(importMatch)) {
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
    function processInlineScripts(vFile) {
        var scripts = /<(script)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gmi,
            vPath = path.parse(vFile.path),
            vSource = vFile.source;

        return new Promise(function (resolve) {
            function check() {
                var scriptMatch = scripts.exec(vSource),
                    scriptContent = scriptMatch && scriptMatch[3],
                    inlineFile;
                if (!scriptMatch) { return resolve(vFile); }
                if (!scriptContent) { return check(); }

                inlineFile = {
                    path: path.join(
                        vPath.dir,
                        vPath.name + '_script_' + scriptMatch.index + '.js'
                    ),
                    source: scriptContent
                };
                regenerate(inlineFile)
                    .then(babelPromise)
                    .then(browserifyPromise)
                    .then(function (iFile) {
                        vFile.source =
                            replaceMatch(scriptMatch, iFile.source, 3);
                        check();
                    })
                    .catch(function (errorFile) {
                        vFile.source =
                            replaceMatch(
                                scriptMatch,
                                outputJSError(errorFile.source),
                                3);
                        check();
                    });
            }
            check();
        });
    }

    function resolveFilePath(fileName, parentName) {
        var dir = path.dirname(parentName);
        fileName = path.join(dir, fileName);
        if (!path.extname(fileName)) {
            return path.join(fileName, 'index.html');
        }
        return fileName;
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
    function replaceEnvVars(vFile) {
        var pattern = /\$ENV\[['"]?([\w\.\-\/@]+?)['"]?\]/g;
        return new Promise(function (resolve) {
            vFile.source = vFile.source.replace(pattern, function (_, v) {
                return process.env[v] || '';
            });
            resolve(vFile);
        });
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

    function getDiff(a, b) {
        const styles = /(<style\b[^>]*>[\s\S]*?<\/style>?)|(<script\b[^>]*>[\s\S]*?<\/script>?)/,
            contentMatch = /<style\b([^>]*)>([\s\S]*?)<\/style>|<script\b[^>]*>([\s\S]*?)<\/script>?/,
            changes = [];

        a = a.split(styles).filter((i) => i);
        b = b.split(styles).filter((i) => i);

        a.forEach((line, index) => {
            if(b[index] !== line) {
                const source = b[index].match(contentMatch);
                let type;
                if (line.match('<script')) {
                    if (!changes.type) changes.type = 'script';
                    if (changes.type !== 'script') changes.type = 'mixed';
                    type = 'script';
                } else if (line.match('<style')) {
                    if (!changes.type) changes.type = 'style';
                    if (changes.type !== 'style') changes.type = 'mixed';
                    type = 'style';
                } else {
                    if (!changes.type) changes.type = 'dom';
                    if (changes.type !== 'dom') changes.type = 'mixed';
                    type = 'dom';
                }
                changes.push({
                    type,
                    was: a[index],
                    became: b[index],
                    attributes: source && source[1],
                    source: source && source[2]
                });
            }
        });

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

        if (changes.type === 'style') {
            const format = getStyleType(changes[0].attributes);
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
            .then(replaceSSI)
            .then(replaceEnvVars)
            //.then(mergeInlineScripts)
            //.then(groupLinkTags)
            .then(processInlineStyles)
            .then(processInlineScripts)
            .then(broadcastChanges.bind(this))
            .then(cachefy)
            .then((isBroadcast) => {
                if (!isBroadcast) { this.reload(filePath); }
            })
            .catch(console.error);
    }
    function onJSChange(eventName, filePath) {
        readFile(filePath)
            .then(regenerate)
            .then(babelPromise)
            .then(browserifyPromise)
            .then(replaceEnvVars)
            .catch(function (errorFile) {
                errorFile.source = outputJSError(errorFile.source);
                return errorFile;
            })
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
