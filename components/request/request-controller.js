define([
  'forge/js/forge',
  'did-io',
  'node-uuid'
], function(forge, didiojs, uuid) {

'use strict';

/* @ngInject */
function factory($scope, $http, $location, ipCookie, config, brAlertService) {
  var self = this;
  self.loginRequired = false;
  self.generating = false;
  self.keyInfo = {};
  self.publicComputer = false;
  var pki = forge.pki;
  var didio = didiojs({inject: {
    forge: forge,
    uuid: uuid
  }});

  /**
   * Helper method to generate a temporary keypair asynchronously.
   *
   * @return a promise that resolves to a keypair, or rejects with the error.
   */
  self._generateTemporaryKey = function() {
    return new Promise(function(resolve, reject) {
      // skip temporary key generation if this is not a public computer
      if(!self.publicComputer) {
        return resolve();
      }

      self.generating = true;
      $scope.$apply();
      forge.pki.rsa.generateKeyPair({
        bits: 2048,
        workerScript: '/bower-components/forge/js/prime.worker.js'
      }, function(err, keypair) {
        self.generating = false;
        $scope.$apply();
        if(err) {
          return reject(err);
        }
        // generate the sha-256 public key fingerprint
        var fingerprint = pki.getPublicKeyFingerprint(keypair.publicKey, {
          md: forge.md.sha256.create(),encoding: 'hex', delimiter: ':'
        });

        return resolve({
          id: 'urn:rsa-public-key-sha256:' + fingerprint,
          publicKeyPem: forge.pki.publicKeyToPem(keypair.publicKey),
          privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey)
        });
      });
    });
  };

  /**
   * Attempt to redirect the browser if a session exists.
   */
  self.redirect = function() {
    try {
      var session = ipCookie('session');
      // refresh session
      ipCookie('session', session, {
        expires: 120,
        expirationUnit: 'minutes'
      });

      // extract the keyInfo if it exists in the session
      self.keyInfo = session.publicKey;

      _navigateToIdp(session);
    } catch(e) {
      self.loginRequired = true;
    }
  };

  /**
   * Perform a login and redirect the browser if the login is
   * successful.
   *
   * @param username the username to use when logging in.
   * @param password the password to use when logging in.
   */
  self.login = function(username, password) {
    var hash = didio.generateHash(username, password);
    self.keyInfo = localStorage.getItem(hash);
    var privateKey = null;

    // try to JSON parse the self.keyInfo
    try {
      self.keyInfo = JSON.parse(self.keyInfo);
    } catch(err) {
      console.log('Error: Failed to extract key information for this device.');
    }

    // decrypt the encrypted key, if it exists
    if(self.keyInfo && self.keyInfo.privateKeyPem) {
      privateKey = pki.decryptRsaPrivateKey(
        self.keyInfo.privateKeyPem, username + password);
    }

    // fetch the username + passphrase mapping
    var did = null;
    Promise.resolve($http.get('/mappings/' + hash))
      .then(function(response) {
        // the mapping fetch succeeded
        if(response.data && response.data.did) {
          did = response.data.did;
        } else {
          throw new Error('DID lookup failed');
        }

        return self._generateTemporaryKey(hash);
      }).then(function(key) {
        if(self.publicComputer) {
          self.keyInfo = key;
          privateKey = pki.privateKeyFromPem(self.keyInfo.privateKeyPem);
        }

        // get the DID document
        return Promise.resolve($http.get('/dids/' + did));
      }).then(function(response) {
        // fetched the person's DID document
        var didDocument = response.data;
        return Promise.resolve($http.get('/dids/' + didDocument.idp));
      }).then(function(response) {
        // fetched the person's IdP DID document
        var idpDidDocument = response.data;
        // TODO: remove this backwards-compatibility hack, only fetch
        // idpDidDocument.url in the future
        if('credentialRequestUrl' in idpDidDocument &&
          'storageRequestUrl' in idpDidDocument) {
          return Promise.resolve(idpDidDocument);
        }

        // get the IdP's service end points
        // TODO: hit `url` directly with JSON-LD request instead of using
        // .well-known
        var url = idpDidDocument.url + '/.well-known/identity';
        return Promise.resolve($http.get(url));
      }).then(function(response) {
        var idpConfig = response.data;

        // fetched IdP's service config
        // extract the IdP DID credential request URL
        // FIXME: security issue - do not store the public key information
        // in a cookie since the private key is sent unencrypted to/from
        // authorization.io
        var cookie = {
          did: did,
          publicKey: {
            id: self.keyInfo.id,
            owner: self.keyInfo.owner,
            publicKeyPem: self.keyInfo.publicKeyPem,
            privateKeyPem: pki.privateKeyToPem(privateKey)
          },
          credentialRequestUrl: idpConfig.credentialsRequestUrl,
          storageRequestUrl: idpConfig.storageRequestUrl
        };
        ipCookie('session', cookie, {
          expires: 120,
          expirationUnit: 'minutes'
        });

        return cookie;
      }).then(_navigateToIdp)
      .catch(function(err) {
        brAlertService.add('error', 'Unable to log in.');
        console.log(err);
      }).then(function() {
        $scope.$apply();
      });
  };

  function _navigateToIdp(session) {
    var id = uuid.v4();
    var authioCallback =
      config.data.baseUri + '/credentials?id=' + id;
    var credentialCallback = $location.search().credentialCallback;
    var storageCallback = $location.search().storageCallback;

    if(credentialCallback && !config.data.sendCryptographicKeyCredential) {
      sessionStorage.setItem(id, credentialCallback);

      // add the public key for the request (if one exists)
      if(self.keyInfo.publicKeyPem) {
        config.data.credentialRequest.publicKey = {
          publicKeyPem: self.keyInfo.publicKeyPem
        };
        if(self.keyInfo.id) {
          config.data.credentialRequest.publicKey.id = self.keyInfo.id;
        }
      }

      navigator.credentials.request(config.data.credentialRequest, {
        requestUrl: session.credentialRequestUrl,
        credentialCallback: authioCallback
      });
    } else if(credentialCallback && config.data.sendCryptographicKeyCredential) {
      // clone template
      var identity = JSON.parse(JSON.stringify(
        config.data.identityWithCryptographicKeyCredentialTemplate));
      identity.id = session.did;
      identity.signature.creator = session.publicKey.id;
      var credential = identity.credential[0]['@graph'];
      credential.claim = {
        id: session.did,
        publicKey: {
          id: session.publicKey.id,
          publicKeyPem: session.publicKey.publicKeyPem,
          owner: session.publicKey.owner
        }
      };
      credential.signature.creator = session.publicKey.id;

      navigator.credentials.transmit(identity, {
        responseUrl: credentialCallback
      });
    } else if(storageCallback) {
      sessionStorage.setItem(id, storageCallback);
      navigator.credentials.store(config.data.storageRequest, {
        requestUrl: session.storageRequestUrl,
        storageCallback: authioCallback
      });
    }
  }

}

return {RequestController: factory};

});