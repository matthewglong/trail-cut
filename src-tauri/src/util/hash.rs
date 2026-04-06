use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn path_hash(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
