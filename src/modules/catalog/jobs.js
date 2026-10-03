'use strict';

module.exports = {
  processors: [
    {
      // One product import: creates the products and writes the error report
      // (importExport/productTransfer.js). The `io` queue tries a job once;
      // the import row records what happened either way.
      queue: 'io',
      name: 'catalog.import',
      // eslint-disable-next-line global-require
      handle: (job) => require('./importExport/productTransfer').runImport(job.payload.importId),
    },
  ],
};
