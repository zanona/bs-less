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

    bs.init({
        notify: false,
        server: serverPath,
        files: [
            serverPath + '*.html',
            serverPath + 'scripts/*.js',
            serverPath + '*.js',
            {
                options: { ignoreInitial: true },
                match: [ serverPath + 'styles/*.less' ],
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
            console.log('URL', req.url);
            var filePath = url.parse(req.url).pathname;
            if (path.extname(filePath) === '.less') {
                compileLess(path.join(serverPath, filePath), res);
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
