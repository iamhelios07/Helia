use serde_json::Value;

fn error(phase: &str, path: &[String], code: &str) -> String {
    format!(
        "{phase}: {} — {code}",
        serde_json::to_string(path).unwrap_or_default()
    )
}
pub(crate) fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| equal(v, other)))
        }
        _ => a == b,
    }
}
fn clean(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().all(|(key, value)| {
            !["__proto__", "prototype", "constructor"].contains(&key.as_str()) && clean(value)
        }),
        Value::Array(values) => values.iter().all(clean),
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        _ => true,
    }
}
fn base_type(schema: &Value) -> Option<&str> {
    schema["type"].as_str().or_else(|| {
        schema["type"]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .find(|t| *t != "null")
    })
}
fn validate_types(schema: &Value, path: &[String]) -> Result<(), String> {
    let fail = |code| error("schema", path, code);
    let types: Vec<&str> = if let Some(types) = schema["type"].as_array() {
        if types.len() != 2 || !types.contains(&Value::String("null".into())) {
            return Err(fail("unsupported-type"));
        }
        let types: Option<Vec<_>> = types.iter().map(Value::as_str).collect();
        let types = types.ok_or_else(|| fail("unsupported-type"))?;
        if types[0] == types[1] {
            return Err(fail("unsupported-type"));
        }
        types
    } else {
        vec![
            schema["type"]
                .as_str()
                .ok_or_else(|| fail("unsupported-type"))?,
        ]
    };
    if types.iter().any(|t| {
        ![
            "object", "array", "string", "number", "integer", "boolean", "null",
        ]
        .contains(t)
    }) {
        return Err(fail("unsupported-type"));
    }
    Ok(())
}
fn visit_schema(schema: &Value, path: &[String], depth: usize) -> Result<(), String> {
    let fail = |code| error("schema", path, code);
    let object = schema.as_object().ok_or_else(|| fail("invalid-schema"))?;
    if depth > 64 {
        return Err(fail("invalid-schema"));
    }
    validate_types(schema, path)?;
    let kind = base_type(schema).ok_or_else(|| fail("unsupported-type"))?;
    let mut allowed = vec!["type", "title", "description", "enum"];
    if kind == "object" {
        allowed.extend(["properties", "required", "additionalProperties"]);
    }
    if kind == "array" {
        allowed.push("items");
    }
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(fail("unsupported-keyword"));
    }
    if ["title", "description"]
        .iter()
        .any(|key| schema.get(key).is_some_and(|v| !v.is_string()))
    {
        return Err(fail("expected-string"));
    }
    if kind == "object" {
        let properties = schema["properties"]
            .as_object()
            .ok_or_else(|| fail("expected-properties"))?;
        if schema["additionalProperties"] != false {
            return Err(fail("closed-object-required"));
        }
        for (key, child) in properties {
            let mut child_path = path.to_vec();
            child_path.extend(["properties".into(), key.clone()]);
            visit_schema(child, &child_path, depth + 1)?;
        }
        if let Some(required) = schema.get("required") {
            let required = required
                .as_array()
                .ok_or_else(|| fail("invalid-required"))?;
            for (i, key) in required.iter().enumerate() {
                if key.as_str().is_none_or(|key| !properties.contains_key(key))
                    || required[..i].contains(key)
                {
                    return Err(fail("invalid-required"));
                }
            }
        }
    } else if kind == "array" {
        let mut child_path = path.to_vec();
        child_path.push("items".into());
        visit_schema(&schema["items"], &child_path, depth + 1)?;
    }
    if let Some(values) = schema.get("enum") {
        let values = values
            .as_array()
            .filter(|values| !values.is_empty())
            .ok_or_else(|| fail("invalid-enum"))?;
        let mut without_enum = schema.clone();
        without_enum.as_object_mut().unwrap().remove("enum");
        for (i, value) in values.iter().enumerate() {
            check(&without_enum, value, "schema", path)?;
            if values[..i].iter().any(|other| equal(value, other)) {
                return Err(fail("duplicate-enum"));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_schema(schema: &Value) -> Result<(), String> {
    if !clean(schema) {
        return Err(error("schema", &[], "invalid-json-schema"));
    }
    visit_schema(schema, &[], 0)
}
fn check(schema: &Value, value: &Value, phase: &str, path: &[String]) -> Result<(), String> {
    let fail = |code| error(phase, path, code);
    if schema["enum"]
        .as_array()
        .is_some_and(|values| !values.iter().any(|item| equal(item, value)))
    {
        return Err(fail("enum"));
    }
    if value.is_null()
        && (schema["type"] == "null"
            || schema["type"]
                .as_array()
                .is_some_and(|types| types.contains(&Value::String("null".into()))))
    {
        return Ok(());
    }
    match base_type(schema) {
        Some("object") => {
            let fields = value.as_object().ok_or_else(|| fail("expected-object"))?;
            let properties = schema["properties"]
                .as_object()
                .ok_or_else(|| fail("invalid-schema"))?;
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    if !fields.contains_key(key.as_str().unwrap()) {
                        let mut p = path.to_vec();
                        p.push(key.as_str().unwrap().into());
                        return Err(error(phase, &p, "required"));
                    }
                }
            }
            for (key, value) in fields {
                let mut p = path.to_vec();
                p.push(key.clone());
                let child = properties
                    .get(key)
                    .ok_or_else(|| error(phase, &p, "additional-property"))?;
                check(child, value, phase, &p)?;
            }
        }
        Some("array") => {
            let values = value.as_array().ok_or_else(|| fail("expected-array"))?;
            for (index, value) in values.iter().enumerate() {
                let mut p = path.to_vec();
                p.push(index.to_string());
                check(&schema["items"], value, phase, &p)?;
            }
        }
        Some("integer")
            if value
                .as_f64()
                .is_some_and(|v| v.is_finite() && v.fract() == 0.0) => {}
        Some("number") if value.as_f64().is_some_and(f64::is_finite) => {}
        Some("string") if value.is_string() => {}
        Some("boolean") if value.is_boolean() => {}
        Some(kind) => return Err(fail(&format!("expected-{kind}"))),
        None => return Err(fail("invalid-schema")),
    }
    Ok(())
}
pub(crate) fn validate_value(schema: &Value, value: &Value, phase: &str) -> Result<(), String> {
    if !clean(value) {
        return Err(error(phase, &[], "invalid-json"));
    }
    check(schema, value, phase, &[])
}
pub(crate) fn validate_document(document: &Value) -> Result<(), String> {
    validate_schema(&document["schema"])?;
    if document["schema"]["type"] != "object" {
        return Err(error("schema", &[], "root-must-be-object"));
    }
    validate_value(&document["schema"], &document["initialState"], "initial")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shares_schema_conformance_cases_with_the_web_runtime() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/lib/games/state/schema-fixtures.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let result = validate_schema(&case["schema"]);
            if case["schemaValid"] == false {
                assert!(result.is_err(), "{}", case["name"]);
                continue;
            }
            assert!(result.is_ok(), "{}: {:?}", case["name"], result);
            for value in case["valid"].as_array().unwrap() {
                assert!(
                    validate_value(&case["schema"], value, "load").is_ok(),
                    "{}: {value}",
                    case["name"]
                );
            }
            for value in case["invalid"].as_array().unwrap() {
                assert!(
                    validate_value(&case["schema"], value, "load").is_err(),
                    "{}: {value}",
                    case["name"]
                );
            }
        }
    }
}
