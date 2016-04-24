/*jslint node:true*/
module.exports = function (serverPath) {

    var path = require('path'),
        fs = require('fs'),
        url  = require('url'),
        bs = require('browser-sync').create(),
        less = require('less'),
        autoprefixer = require('autoprefixer-core'),
        browserify = require('browserify'),
        postcss = require('postcss');

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
    function compileLess(filePath, res) {
        function autoprefix(lessResponse) {
            return postcss([autoprefixer]).process(lessResponse.css, {
                from: path.basename(filePath),
                map: true
            });
        }
        function respond(autoprefixResponse) {
            var css = autoprefixResponse.css;
            if (autoprefix.warnings) {
                autoprefix.warnings().forEach(function (warn) {
                    console.warn(warn.toString());
                });
            }
            res.setHeader('content-type', 'text/css');
            res.setHeader('content-length', css.length);
            res.end(css);
        }
        function onLessfile(err, contents) {
            if (err) { return res.end(err.message); }
            less
                .render(contents.toString(), {
                    filename: filePath,
                    relativeUrls: true,
                    sourceMap: {
                        outputSourceFiles: true,
                        sourceMapBasepath: serverPath,
                        sourceMapFileInline: true
                    }
                })
                .then(autoprefix)
                .then(respond)
                .catch(function (error) {
                    error = JSON.stringify(error, null, 4)
                        .replace(/\n/g, '\\A')
                        .replace(/"/g, '\\"');

                    res.end(outputStyleError(error));
                });
        }
        fs.readFile(filePath, onLessfile);
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
    }

    function outputSource(vFile) { return vFile.source; }
    function outputJSError(err) {
        var err = err.stack
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');

        return 'console.error("' + err + '");';
    }
    function browserifyPromise(filePath) {
        return new Promise(function (resolve, reject) {
            browserify(filePath, {debug: true})
                .bundle(function (err, bundle) {
                    if (err) { return reject(err); }
                    resolve({
                        path: filePath,
                        source: bundle.toString()
                    });
                });
        });
    }

    bs.init({
        notify: false,
        server: serverPath,
        files: [
            serverPath + '*.html',
            serverPath + '*.js',
            serverPath + 'scripts/*.js',
            serverPath + 'lib/**.js',
            {
                options: { ignoreInitial: true },
                match: [
                    serverPath + '*.less',
                    serverPath + '*/*.less',
                    serverPath + 'lib/**.less'
                ],
                fn: function (event) {
                    if (event !== 'change') { return; }
                    //this.reload(path.relative(serverPath, filePath));
                    this.reload('*.less');
                }
            }
        ],
        injectFileTypes: ['less'],
        middleware: function (req, res, next) {
            // It seems there's problem when using BS .then(res.end)
            // creating my own method
            function end(data) { return res.end(data); }

            var cURL = req.url.replace(/\/$/, '/index.html'),
                filePath = url.parse(cURL).pathname,
                fileSrc = path.join(serverPath, filePath),
                ext = path.extname(filePath),
                f;
            if (ext.match(/\.less$/)) {
                return compileLess(fileSrc, res);
            } else if (ext.match(/\.js$/)) {
                if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    f = readFile(fileSrc);
                } else {
                    f = browserifyPromise(fileSrc);
                }
                f.then(replaceEnvVars)
                 .then(outputSource)
                 .then(end)
                 .catch(function (e) { res.end(outputJSError(e)); });
            } else if (ext.match(/\.html$/)) {
                return readFile(fileSrc)
                    .then(replaceEnvVars)
                    .then(outputSource)
                    .then(end)
                    .catch(end);
            } else {
                next();
            }
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    });

};
