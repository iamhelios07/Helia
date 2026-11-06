# Public authentication fixture

`service-account.json` contains a generated RSA key pair and a fictional Google service-account identity for offline tests. The private key is intentionally public test material and has never been registered with Google. `test_public_key_der` is used to verify JWT signatures and is stripped by the production credential parser.

Node.js and native tests mock the OAuth grant transport. The ignored native OS-store smoke test writes a randomly named test record and removes it after reading; it does not contact Google or use user credentials.
