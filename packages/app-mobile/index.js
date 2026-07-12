/**
 * @format
 */

// Hermes has no Web Crypto: polyfill crypto.getRandomValues BEFORE anything
// that touches @noble/hashes (pairing secret/code derivation), or generating a
// pairing payload throws "crypto.getRandomValues must be defined".
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
