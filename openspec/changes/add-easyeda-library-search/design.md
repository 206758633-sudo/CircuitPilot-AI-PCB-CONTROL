# Safety design

The Runtime exposes only `library.device.search`. Input is validated to 1-120 characters, mode is `keyword` or `lcsc`, and results are capped at 20. The Bridge builds one of two documented Beta calls: `LIB_Device.search` or `LIB_Device.getByLcscIds`.

Search and project reads are read-only. Binding is local application metadata and never invokes component creation, schematic mutation, export, ordering, or payment.

# Data binding

`ComponentItem.easyEdaBinding` stores device/library UUID plus optional symbol, footprint and 3D-model identities. Existing BOM MPN, quantity and approval state remain unchanged.

Uploaded evidence keeps local ownership. Linking an asset to the current EasyEDA project adds a display association to `linkedTo`; it does not upload the file into EasyEDA.

