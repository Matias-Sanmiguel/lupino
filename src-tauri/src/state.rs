use anyhow::Result;
use lupino_core::Store;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Child,
    sync::{Arc, Mutex},
};
pub struct AppState {
    pub root: PathBuf,
    pub workers: crate::workers::Workers<Arc<Mutex<Child>>>,
    pub secrets: Mutex<HashMap<String, String>>,
}
impl AppState {
    pub fn store(&self) -> Result<Store> {
        Store::open(&self.root)
    }
    pub fn secret(&self, provider: &str) -> Option<String> {
        if let Some(v) = self.secrets.lock().ok()?.get(provider) {
            return Some(v.clone());
        }
        keyring::Entry::new("app.lupino.ai", provider)
            .ok()?
            .get_password()
            .ok()
    }
    pub fn save_secret(&self, provider: &str, value: &str) -> Result<String> {
        if !["claude", "cursor"].contains(&provider)
            || value.trim().is_empty()
            || value.len() > 8192
        {
            anyhow::bail!("Credencial inválida");
        }
        self.secrets
            .lock()
            .unwrap()
            .insert(provider.into(), value.into());
        match keyring::Entry::new("app.lupino.ai",provider).and_then(|entry|entry.set_password(value)) {
            Ok(())=>Ok("Credencial guardada en el almacén seguro del sistema.".into()),
            Err(_)=>Ok("El almacén seguro no está disponible. La credencial se conserva sólo durante esta sesión.".into()),
        }
    }
    pub fn clear_secret(&self, provider: &str) -> Result<()> {
        self.secrets.lock().unwrap().remove(provider);
        match keyring::Entry::new("app.lupino.ai", provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow::anyhow!(
                "No se pudo borrar la credencial del almacén seguro: {e}"
            )),
        }
    }
}

pub fn provider_result(mut data: serde_json::Value, note: &str) -> serde_json::Value {
    if !note.is_empty() {
        data["note"] = serde_json::json!(note);
    }
    data
}
#[cfg(test)]
mod tests {
    #[test]
    fn preserves_sdk_credential_storage_warning() {
        let result = super::provider_result(
            serde_json::json!({"connected":true,"note":"Sólo durante esta sesión"}),
            "",
        );
        assert_eq!(result["note"], "Sólo durante esta sesión");
    }
}
