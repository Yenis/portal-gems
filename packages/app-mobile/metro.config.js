const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// wormhole-rn and @portalgems/core are npm file: symlinks into ../. Metro must
// watch their real folders, and must NOT pick up wormhole-rn's own dev copies
// of react/react-native — that would bundle React twice. Force resolution to
// this app's copies and block the duplicates.
const workspaceRoot = path.resolve(__dirname, '..');

const blockDir = (dir) =>
  new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);

const config = {
  watchFolders: [
    path.join(workspaceRoot, 'wormhole-rn'),
    path.join(workspaceRoot, 'core'),
  ],
  resolver: {
    // Make every module (incl. deps imported from the symlinked packages)
    // resolve against this app's node_modules.
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    extraNodeModules: {
      react: path.join(__dirname, 'node_modules/react'),
      'react-native': path.join(__dirname, 'node_modules/react-native'),
      i18next: path.join(__dirname, 'node_modules/i18next'),
      'react-i18next': path.join(__dirname, 'node_modules/react-i18next'),
    },
    blockList: [
      blockDir(path.join(workspaceRoot, 'wormhole-rn/node_modules/react-native')),
      blockDir(path.join(workspaceRoot, 'wormhole-rn/node_modules/react')),
      blockDir(path.join(workspaceRoot, 'wormhole-rn/example')),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
