use thiserror::Error;

#[derive(Debug, Error)]
pub enum BattleError {
    #[error("catalog entry not found: {kind} '{id}'")]
    MissingCatalogEntry { kind: &'static str, id: String },
    #[error("invalid scenario: {0}")]
    InvalidScenario(String),
    #[error("illegal action: {0}")]
    IllegalAction(String),
    #[error("battle is already terminal")]
    AlreadyTerminal,
    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, BattleError>;
