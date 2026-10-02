/* eslint-disable no-undef */

const devCerts = require("office-addin-dev-certs");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { DefinePlugin } = require("webpack");

const urlDev = "https://localhost:3000/";
const urlProd = "https://app.slidecheck.io/";

/**
 * Task-pane Content-Security-Policy (U10). Deck content is untrusted: it is rendered only as text,
 * and this policy is the second line of defence. Only development builds may talk to localhost.
 */
function contentSecurityPolicy(dev) {
  const connect = ["'self'", "https://api.slidecheck.io"];
  if (dev) connect.push("https://localhost:*", "wss://localhost:*"");
  return [
    "default-src 'self'",
    "script-src 'self' https://appsforoffice.microsoft.com",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

async function getHttpsOptions() {
  const httpsOptions = await devCerts.getHttpsServerOptions();
  return { ca: httpsOptions.ca, key: httpsOptions.key, cert: httpsOptions.cert };
}

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  return {
    devtool: "source-map",
    entry: {
      taskpane: ["./src/taskpane/index.tsx", "./src/taskpane/taskpane.html"],
      commands: "./src/commands/commands.ts",
      // Sign-in dialog page (U15): served beside taskpane.html so `messageParent` needs no config.
      signin: "./src/dialog/signin.ts",
    },
    output: {
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".html", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
            options: { transpileOnly: true },
          },
        },
        {
          test: /\.html$/,
          exclude: /node_modules/,
          use: "html-loader",
        },
        {
          test: /\.(png|jpg|jpeg|gif|ico)$/,
          type: "asset/resource",
          generator: {
            filename: "assets/[name][ext][query]",
          },
        },
      ],
    },
    plugins: [
      // Development-only Pro unlock (src/license/devUnlock.ts); `false` strips it from production bundles.
      new DefinePlugin({ __SLIDECHECK_DEV__: JSON.stringify(dev) }),
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        // "!!" + the plugin's own lodash loader, so html-loader (used for the HMR entry) does not
        // swallow the template and `<%= csp %>` is interpolated from templateParameters.
        template: `!!${require.resolve("html-webpack-plugin/lib/loader.js")}!./src/taskpane/taskpane.html`,
        templateParameters: { csp: contentSecurityPolicy(dev) },
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "signin.html",
        // Same CSP as the task pane (the dialog calls the license API cross-origin under connect-src).
        template: `!!${require.resolve("html-webpack-plugin/lib/loader.js")}!./src/dialog/signin.html`,
        templateParameters: { csp: contentSecurityPolicy(dev) },
        chunks: ["signin"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["commands"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "assets/*",
            to: "assets/[name][ext][query]",
          },
          {
            from: "manifest*.xml",
            to: "[name][ext]",
            transform(content) {
              return dev ? content : content.toString().replace(new RegExp(urlDev, "g"), urlProd);
            },
          },
        ],
      }),
    ],
    devServer: {
      hot: true,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      server: {
        type: "https",
        options: env.WEBPACK_BUILD || options.https !== undefined ? options.https : await getHttpsOptions(),
      },
      port: process.env.npm_package_config_dev_server_port || 3000,
    },
  };
};
