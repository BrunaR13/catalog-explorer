import { createApp, server } from '@databricks/appkit';
import { catalogExplorer } from './catalog-explorer-plugin.js';

createApp({
  plugins: [server(), catalogExplorer()],
}).catch(console.error);
