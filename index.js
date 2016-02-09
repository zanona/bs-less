/*jslint node:true*/
module.exports = function (serverPath) {
    'use strict';

    var path = require('path'),
        fs = require('fs'),
        url  = require('url'),
        bs = require('browser-sync').create(),
        less = require('less'),
        autoprefixer = require('autoprefixer-core'),
        postcss = require('postcss');

    function compileLess(filePath, res) {

        function autoprefix(less) {
            return postcss([autoprefixer]).process(less.css, {
                from: path.basename(filePath),
                map: true
            });
        }

        function respond(autoprefix) {
            var css = autoprefix.css;
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
                    sourceMap: {
                        outputSourceFiles: true,
                        sourceMapBasepath: serverPath,
                        sourceMapFileInline: true
                    }
                })
                .then(autoprefix)
                .then(respond)
                .catch(function (err) { res.end(err.message); });
        }

        fs.readFile(filePath, onLessfile);
    }

    function adjustFile(filePath, res) {

        function onFile(err, contents) {
            if (err) { return res.end(err.message); }
            var env = /\$ENV\[['"]?([\w\.\-\/@]+?)['"]?\]/g;
            contents = contents.toString()
                .replace(env, function (m, v) {
                    /*jslint unparam:true*/
                    return process.env[v];
                });
            res.end(contents);
        }

        fs.readFile(filePath, onFile);
    }

    bs.init({
        notify: false,
        server: serverPath,
        files: [
            serverPath + '*.html',
            serverPath + '*.js',
            serverPath + 'scripts/*.js',
            {
                options: { ignoreInitial: true },
                match: [
                    serverPath + '*.less',
                    serverPath + 'styles/*.less'
                ],
                fn: function (event) {
                    if (event !== 'change') { return; }
                    //this.reload(path.relative(serverPath, filePath));
                    this.reload('styles/*.less');
                    //this.reload('styles/atf.less');
                    //this.reload('styles/main.less');
                }
            }
        ],
        injectFileTypes: ['less'],
        middleware: function (req, res, next) {
            var cURL = req.url.replace(/\/$/, '/index.html'),
                filePath = url.parse(cURL).pathname,
                fileSrc = path.join(serverPath, filePath),
                ext = path.extname(filePath);
            if (ext.match(/\.(html|js)/)) {
                adjustFile(fileSrc, res);
            } else if (ext === '.less') {
                compileLess(fileSrc, res);
            } else { next(); }
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    });

};
