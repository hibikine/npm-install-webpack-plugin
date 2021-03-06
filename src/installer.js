/* eslint-disable no-console, consistent-return,no-useless-escape */
const fs = require('fs');
const path = require('path');

const util = require('util');

const resolve = require('resolve');

const spawn = require('cross-spawn');

const JSON5 = require('json5');

// Match "react", "path", "fs", "lodash.random", etc.
const EXTERNAL = /^\w[a-z\-0-9\.]+$/;
const PEERS = /UNMET PEER DEPENDENCY ([a-z\-0-9\.]+)@(.+)/gm;

const defaultOptions = {
  dev: false,
  peerDependencies: true,
  quiet: false,
  npm: 'npm',
};
const erroneous = [];

function normalizeBabelPlugin(plugin, prefix) {
  // Babel plugins can be configured as [plugin, options]
  if (Array.isArray(plugin)) {
    plugin = plugin[0];
  }
  if (plugin.indexOf(prefix) === 0) {
    return plugin;
  }
  return prefix + plugin;
}

module.exports.packageExists = function packageExists() {
  const pkgPath = path.resolve('package.json');
  try {
    require.resolve(pkgPath);
    // Remove cached copy for future checks
    delete require.cache[pkgPath];
    return true;
  } catch (e) {
    return false;
  }
};

module.exports.check = function check(request) {
  if (!request) {
    return;
  }

  const namespaced = request.charAt(0) === '@';
  const dep = request
    .split('/')
    .slice(0, namespaced ? 2 : 1)
    .join('/');
  // Ignore relative modules, which aren't installed by NPM
  if (!dep.match(EXTERNAL) && !namespaced) {
    return;
  }

  // Ignore modules which can be resolved using require.resolve()'s algorithm
  try {
    resolve.sync(dep, { basedir: process.cwd() });
    return;
  } catch (e) {
    // Module is not resolveable
  }

  return dep;
};

module.exports.checkBabel = function checkBabel() {
  let babelOpts;
  let babelrc;
  try {
    babelrc = require.resolve(path.resolve('.babelrc'));
    babelOpts = JSON5.parse(fs.readFileSync(babelrc, 'utf8'));
  } catch (e) {
    try {
      const babelConfigJs = require.resolve(path.resolve('babel.config.js'));
      babelOpts = require(babelConfigJs);
    } catch (e2) {
      console.info("couldn't locate babel.config.js nor .babelrc");
    }
    if (babelrc) {
      console.info('.babelrc is invalid JSON5, babel deps are skipped');
    }
    // Babel isn't installed, don't install deps
    return;
  }

  // Default plugins/presets
  const options = Object.assign(
    {
      plugins: [],
      presets: [],
    },
    babelOpts
  );

  if (!options.env) {
    options.env = {};
  }

  if (!options.env.development) {
    options.env.development = {};
  }

  // Default env.development plugins/presets
  options.env.development = Object.assign(
    {
      plugins: [],
      presets: [],
    },
    options.env.development
  );

  // Accumulate babel-core (required for babel-loader)+ all dependencies
  const deps = ['@babel/core']
    .concat(
      options.plugins.map((plugin) =>
        normalizeBabelPlugin(plugin, 'babel-plugin-')
      )
    )
    .concat(
      options.presets.map((preset) =>
        normalizeBabelPlugin(preset, '@babel/preset-')
      )
    )
    .concat(
      options.env.development.plugins.map((plugin) =>
        normalizeBabelPlugin(plugin, 'babel-plugin-')
      )
    )
    .concat(
      options.env.development.presets.map((preset) =>
        normalizeBabelPlugin(preset, '@babel/preset-')
      )
    );

  // Check for missing dependencies
  const missing = deps.filter(
    // eslint-disable-next-line func-names
    function(dep) {
      return this.check(dep);
    }.bind(this)
  );

  // Install missing dependencies
  this.install(missing);
};

module.exports.defaultOptions = defaultOptions;

module.exports.install = function install(deps, options) {
  if (!deps) {
    return;
  }

  if (!Array.isArray(deps)) {
    deps = [deps];
  }

  options = Object.assign({}, defaultOptions, options);

  // Ignore known, erroneous modules
  deps = deps.filter((dep) => erroneous.indexOf(dep) === -1);

  if (!deps.length) {
    return;
  }

  let args;
  let client;
  let quietOptions;
  let save;
  if (options.yarn) {
    args = ['add'];
    client = 'yarn';
    save = options.dev ? '--dev' : null;
    quietOptions = ['--silent'];
  } else {
    args = ['install'];
    client = options.npm;
    save = options.dev ? '--save-dev' : '--save';
    quietOptions = ['--silent', '--no-progress'];
  }

  args = args.concat(deps).filter(Boolean);

  if (save && module.exports.packageExists()) {
    args.push(save);
  }

  if (options.quiet) {
    args = args.concat(quietOptions);
  }

  deps.forEach((dep) => {
    console.info('Installing %s...', dep);
  });

  // Ignore input, capture output, show errors
  const output = spawn.sync(client, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (output.status) {
    deps.forEach((dep) => {
      erroneous.push(dep);
    });
  }

  let matches = null;
  const peers = [];

  // RegExps track return a single result each time
  // eslint-disable-next-line no-cond-assign
  while ((matches = PEERS.exec(output.stdout))) {
    const dep = matches[1];
    const version = matches[2];

    // Ranges don't work well, so let NPM pick
    if (version.match(' ')) {
      peers.push(dep);
    } else {
      peers.push(util.format('%s@%s', dep, version));
    }
  }

  if (options.peerDependencies && peers.length) {
    console.info('Installing peerDependencies...');
    this.install(peers, options);
    console.info('');
  }

  return output;
};
