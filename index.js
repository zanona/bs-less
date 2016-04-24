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
                .catch(res.end);
        }
        fs.readFile(filePath, onLessfile);
    }
    function replaceEnvVars(contents) {
        var env = /\$ENV\[['"]?([\w\.\-\/@]+?)['"]?\]/g;
        contents = contents.toString()
            .replace(env, function (_, v) { return process.env[v]; });
        return contents;
    }
    function adjustFile(filePath, res) {
        function onFile(err, contents) {
            if (err) { return res.end(err.message); }
            contents = replaceEnvVars(contents, res);
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
            if (ext.match(/\.less$/)) {
                return compileLess(fileSrc, res);
            }
            if (ext.match(/\.js$/)) {
                if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    return adjustFile(fileSrc, res);
                }
                browserify(fileSrc, {debug: true})
                    .bundle(function (err, bundle) {
                        bundle = replaceEnvVars(bundle, res);
                        res.end(bundle);
                    });
                return;
            }
            if (ext.match(/\.html$/)) {
                return adjustFile(fileSrc, res);
            }
            next();
        },
        snippetOptions: {
            rule: {
                match: /$/,
                fn: function (snippet) { return snippet; }
            }
        }
    });

};
