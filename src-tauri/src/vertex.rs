use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const ACCOUNT_ERROR: &str = "올바른 Service Account JSON과 RSA 개인 키를 입력해주세요.";
const AUTH_ERROR: &str =
    "서비스 계정 인증에 실패했어요. JSON 키 상태와 Google Cloud 설정을 확인해주세요.";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VertexSettings {
    pub project_id: String,
    pub location: String,
}

impl VertexSettings {
    pub fn base_url(&self) -> Result<String, String> {
        let project = &self.project_id;
        let number =
            (6..=20).contains(&project.len()) && project.bytes().all(|b| b.is_ascii_digit());
        let project_id = (6..=30).contains(&project.len())
            && project.as_bytes()[0].is_ascii_lowercase()
            && project
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            && project
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let region = self.location.split('-').collect::<Vec<_>>();
        let location = self.location == "global"
            || (self.location.len() <= 63
                && region.len() >= 2
                && !region[0].is_empty()
                && region[0].bytes().all(|b| b.is_ascii_lowercase())
                && region.iter().skip(1).all(|s| {
                    !s.is_empty()
                        && s.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                })
                && self
                    .location
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_digit));
        if !(number || project_id) || !location {
            return Err("프로젝트 ID와 Vertex AI 리전을 확인해주세요.".into());
        }
        let host = if self.location == "global" {
            "aiplatform.googleapis.com".to_owned()
        } else {
            format!("{}-aiplatform.googleapis.com", self.location)
        };
        Ok(format!(
            "https://{host}/v1/projects/{project}/locations/{}/publishers/google",
            self.location
        ))
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct ServiceAccount {
    #[serde(rename = "type")]
    pub account_type: String,
    pub project_id: String,
    pub private_key_id: String,
    pub private_key: String,
    pub client_email: String,
    pub token_uri: String,
}
impl ServiceAccount {
    pub fn parse(source: &str) -> Result<Self, String> {
        if source.len() > 65536 {
            return Err(ACCOUNT_ERROR.into());
        }
        let account: Self = serde_json::from_str(source).map_err(|_| ACCOUNT_ERROR)?;
        account.validate()?;
        Ok(account)
    }
    pub fn validate(&self) -> Result<(), String> {
        let email = self.client_email.split('@').collect::<Vec<_>>();
        if self.account_type != "service_account"
            || self.token_uri != TOKEN_URL
            || email.len() != 2
            || self.client_email.len() > 254
            || email[0].is_empty()
            || !email[1].ends_with(".gserviceaccount.com")
            || !email[0]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || !email[1]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            || self.private_key_id.is_empty()
            || self.private_key_id.len() > 128
            || !self
                .private_key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(ACCOUNT_ERROR.into());
        }
        VertexSettings {
            project_id: self.project_id.clone(),
            location: "global".into(),
        }
        .base_url()
        .map_err(|_| ACCOUNT_ERROR)?;
        self.key_pair()?;
        Ok(())
    }
    fn key_pair(&self) -> Result<RsaKeyPair, String> {
        if self.private_key.len() > 16384 {
            return Err(ACCOUNT_ERROR.into());
        }
        let key = self.private_key.replace('\r', "");
        let encoded = key
            .trim_end_matches('\n')
            .strip_prefix("-----BEGIN PRIVATE KEY-----\n")
            .and_then(|key| key.strip_suffix("\n-----END PRIVATE KEY-----"))
            .ok_or(ACCOUNT_ERROR)?
            .replace('\n', "");
        let der = STANDARD.decode(encoded).map_err(|_| ACCOUNT_ERROR)?;
        RsaKeyPair::from_pkcs8(&der).map_err(|_| ACCOUNT_ERROR.into())
    }
    fn assertion(&self, now: u64) -> Result<String, String> {
        self.validate()?;
        let header = URL_SAFE_NO_PAD.encode(
            json!({ "alg": "RS256", "typ": "JWT", "kid": self.private_key_id }).to_string(),
        );
        let claims = URL_SAFE_NO_PAD.encode(json!({ "iss": self.client_email, "scope": "https://www.googleapis.com/auth/cloud-platform", "aud": TOKEN_URL, "iat": now, "exp": now + 3600 }).to_string());
        let input = format!("{header}.{claims}");
        let key = self.key_pair()?;
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input.as_bytes(),
            &mut signature,
        )
        .map_err(|_| AUTH_ERROR)?;
        Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }
}

struct CachedToken {
    token: String,
    expires: u64,
}
#[derive(Default)]
struct TokenCache(Mutex<HashMap<String, CachedToken>>);
static TOKENS: OnceLock<TokenCache> = OnceLock::new();
pub(crate) fn clear_tokens() {
    if let Ok(mut cache) = TOKENS.get_or_init(Default::default).0.lock() {
        cache.clear();
    }
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AUTH_ERROR.into())
}

pub(crate) fn access_token(account: &ServiceAccount) -> Result<String, String> {
    TOKENS
        .get_or_init(Default::default)
        .token(account, now()?, request_token)
}
impl TokenCache {
    fn token(
        &self,
        account: &ServiceAccount,
        current: u64,
        grant: impl FnOnce(&str) -> Result<Vec<u8>, String>,
    ) -> Result<String, String> {
        account.validate()?;
        let fingerprint = ring::digest::digest(
            &ring::digest::SHA256,
            serde_json::to_string(account)
                .map_err(|_| AUTH_ERROR)?
                .as_bytes(),
        );
        let fingerprint = URL_SAFE_NO_PAD.encode(fingerprint);
        if let Some(token) = self
            .0
            .lock()
            .map_err(|_| AUTH_ERROR)?
            .get(&fingerprint)
            .filter(|token| token.expires > current + 60)
        {
            return Ok(token.token.clone());
        }
        let assertion = account.assertion(current)?;
        let bytes = grant(&assertion).map_err(|_| AUTH_ERROR)?;
        if bytes.len() > 65536 {
            return Err(AUTH_ERROR.into());
        }
        let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| AUTH_ERROR)?;
        let token = payload["access_token"]
            .as_str()
            .filter(|token| {
                !token.is_empty() && token.len() <= 16384 && !token.chars().any(char::is_control)
            })
            .ok_or(AUTH_ERROR)?;
        let expires = payload["expires_in"]
            .as_u64()
            .filter(|value| *value > 60 && *value <= 3600)
            .ok_or(AUTH_ERROR)?;
        if !payload["token_type"]
            .as_str()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
        {
            return Err(AUTH_ERROR.into());
        }
        let mut tokens = self.0.lock().map_err(|_| AUTH_ERROR)?;
        if tokens.len() >= 64 {
            tokens.clear();
        }
        tokens.insert(
            fingerprint,
            CachedToken {
                token: token.to_owned(),
                expires: current + expires,
            },
        );
        Ok(token.to_owned())
    }
}
fn request_token(assertion: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| AUTH_ERROR)?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion),
        ])
        .send()
        .map_err(|_| AUTH_ERROR)?;
    if !response.status().is_success() {
        return Err(AUTH_ERROR.into());
    }
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| AUTH_ERROR)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../../src/lib/testing/fixtures/service-account.json");
    #[test]
    fn signs_verifiable_rsa_grants_and_renews_cached_tokens_before_expiry() {
        let account = ServiceAccount::parse(FIXTURE).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let public = STANDARD
            .decode(fixture["test_public_key_der"].as_str().unwrap())
            .unwrap();
        let cache = TokenCache::default();
        let grant = |assertion: &str| {
            let parts = assertion.split('.').collect::<Vec<_>>();
            let claims: serde_json::Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
            assert_eq!(claims["aud"], TOKEN_URL);
            assert_eq!(
                claims["scope"],
                "https://www.googleapis.com/auth/cloud-platform"
            );
            assert_eq!(
                claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
                3600
            );
            ring::signature::UnparsedPublicKey::new(
                &ring::signature::RSA_PKCS1_2048_8192_SHA256,
                &public,
            )
            .verify(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
            )
            .unwrap();
            Ok(json!({ "access_token": "test-only-token", "expires_in": 3600, "token_type": "Bearer" }).to_string().into_bytes())
        };
        assert_eq!(
            cache.token(&account, 1700000000, grant).unwrap(),
            "test-only-token"
        );
        assert_eq!(
            cache
                .token(&account, 1700000001, |_| panic!(
                    "cached token should be reused"
                ))
                .unwrap(),
            "test-only-token"
        );
        assert_eq!(
            cache.token(&account, 1700003541, grant).unwrap(),
            "test-only-token"
        );
    }
    #[test]
    fn rejects_arbitrary_token_hosts_and_does_not_leak_failed_grants() {
        let mut fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        fixture["token_uri"] = json!("https://evil.example/token");
        assert!(ServiceAccount::parse(&fixture.to_string()).is_err());
        let account = ServiceAccount::parse(FIXTURE).unwrap();
        let cache = TokenCache::default();
        assert_eq!(
            cache
                .token(&account, 1700000000, |_| Err(account.private_key.clone()))
                .unwrap_err(),
            AUTH_ERROR
        );
        assert_eq!(
            cache
                .token(&account, 1700000000, |_| Ok(
                    json!({ "access_token": "secret", "expires_in": 0, "token_type": "Bearer" })
                        .to_string()
                        .into_bytes()
                ))
                .unwrap_err(),
            AUTH_ERROR
        );
        assert!(cache.0.lock().unwrap().is_empty());
    }
}
