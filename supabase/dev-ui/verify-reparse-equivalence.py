#!/usr/bin/env python3
"""Verify the reviewed Dev deparser differences without DB or network access.

Only literal, unbounded varchar ARRAY -> text[] cast distribution and ordered
associativity of the same AND/OR operator are normalized. The input checksum
pins this verifier to the independently reviewed 137-pair artifact. Exit zero
proves the 136 SQL-definition pairs only; it does not approve pg_graphql's
managed version difference. This script writes only reparse-equivalence.safe.json.
"""

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


NORMALIZER_VERSION = "dev-reparse-v1"
EXPECTED_INPUT_SHA256 = "c6abf2835677ce33ad9f6bb4b51044d7d91a9b1e72e671143354666a0fc8fba1"
EXPECTED_KINDS = {"constraint": 126, "index": 6, "relation": 2, "trigger": 2}
EXPECTED_CLASSES = {
    "literal_array_cast_distribution": 79,
    "and_associativity": 53,
    "or_associativity": 1,
    "literal_array_cast_distribution_and_and_associativity": 3,
}
TOKEN = re.compile(
    r"[A-Za-z_][A-Za-z_0-9$]*|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?"
    r"|::|->>|->|!~\*|!~|~\*|>=|<=|<>|!=|\|\||[-+*/%=<>~!@#^&|?:]|[()[\],.;]"
)
UNSAFE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
    r"|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"
    r"|\b(?:sbp_|sb_secret_|sb_publishable_|sk_live_|sk_test_)"
    r"|(?:postgres(?:ql)?|https?)://[^\s\"']*@", re.IGNORECASE
)


class VerificationError(Exception):
    """All messages are fixed codes; never interpolate an SQL fragment."""


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def sha256(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode("utf-8")).hexdigest()


def sql_tokens(sql):
    result, i = [], 0
    while i < len(sql):
        if sql[i].isspace():
            i += 1
            continue
        start = i
        escaped = sql[i:i + 2] in ("E'", "e'")
        if escaped or sql[i] in ("'", '"'):
            if escaped:
                i += 1
            quote = sql[i]
            i += 1
            while i < len(sql):
                if escaped and sql[i] == "\\":
                    i += 2
                elif sql[i] == quote:
                    i += 1
                    if i < len(sql) and sql[i] == quote:
                        i += 1
                    else:
                        break
                else:
                    i += 1
            else:
                raise VerificationError("unterminated_quoted_token")
            require(i <= len(sql), "unterminated_escaped_token")
            result.append(sql[start:i])
            continue
        require(not sql.startswith(("--", "/*"), i), "unsupported_sql_comment")
        match = TOKEN.match(sql, i)
        require(match is not None, "unsupported_sql_token")
        result.append(match.group())
        i = match.end()
    return result


def distribute_literal_array_casts(tokens):
    result, rewritten, i = [], 0, 0
    while i < len(tokens):
        if tokens[i:i + 3] == ["(", "ARRAY", "["]:
            end = i + 3
            while end < len(tokens) and tokens[end] != "]":
                end += 1
            parts, part = [], []
            for token in tokens[i + 3:end]:
                if token == ",":
                    parts.append(part)
                    part = []
                else:
                    part.append(token)
            parts.append(part)
            literal_only = bool(parts) and all(
                len(p) == 4 and p[0].startswith("'") and p[0].endswith("'")
                and p[1:] == ["::", "character", "varying"] for p in parts
            )
            if literal_only and tokens[end:end + 6] == ["]", ")", "::", "text", "[", "]"]:
                result.extend(["ARRAY", "["])
                for ordinal, p in enumerate(parts):
                    if ordinal:
                        result.append(",")
                    result.extend(["(", *p, ")", "::", "text"])
                result.append("]")
                rewritten += 1
                i = end + 6
                continue
        result.append(tokens[i])
        i += 1
    return result, rewritten


def group_end(tokens, start=0):
    if start >= len(tokens) or tokens[start] != "(":
        return -1
    depth = 0
    for i in range(start, len(tokens)):
        depth += (tokens[i] == "(") - (tokens[i] == ")")
        if depth == 0:
            return i
        require(depth >= 0, "unbalanced_parentheses")
    raise VerificationError("unbalanced_parentheses")


def boolean_ast(tokens, flattened):
    require(bool(tokens), "empty_boolean_expression")
    while len(tokens) > 1 and group_end(tokens) == len(tokens) - 1:
        tokens = tokens[1:-1]
    require(bool(tokens), "empty_boolean_expression")
    require("BETWEEN" not in tokens, "unsupported_between_expression")
    parens = brackets = cases = 0
    positions = {"OR": [], "AND": []}
    for i, token in enumerate(tokens):
        parens += (token == "(") - (token == ")")
        brackets += (token == "[") - (token == "]")
        cases += (token == "CASE") - (token == "END")
        require(min(parens, brackets, cases) >= 0, "unbalanced_expression")
        if not (parens or brackets or cases) and token in positions:
            positions[token].append(i)
    require(parens == brackets == cases == 0, "unbalanced_expression")
    for operator in ("OR", "AND"):
        if positions[operator]:
            cuts = [-1, *positions[operator], len(tokens)]
            children = []
            for left, right in zip(cuts, cuts[1:]):
                child = boolean_ast(tokens[left + 1:right], flattened)
                if child[0] == operator:
                    flattened[operator] += 1
                    children.extend(child[1:])
                else:
                    children.append(child)
            return [operator, *children]
    if tokens[0] == "NOT":
        return ["NOT", boolean_ast(tokens[1:], flattened)]
    return ["atom", *tokens]


def normalize_sql(kind, sql):
    tokens, rewritten = distribute_literal_array_casts(sql_tokens(sql))
    flattened = Counter({"AND": 0, "OR": 0})
    canonical = tokens
    if kind == "constraint":
        require(tokens[:2] == ["CHECK", "("], "unexpected_constraint_shape")
        end = group_end(tokens, 1)
        suffix = tokens[end + 1:]
        require(suffix in ([], ["NOT", "VALID"], ["NO", "INHERIT"],
                           ["NO", "INHERIT", "NOT", "VALID"]), "unsupported_constraint_suffix")
        canonical = ["CHECK", boolean_ast(tokens[2:end], flattened), suffix]
    return canonical, tokens, rewritten, flattened


def self_test():
    positive = [
        ("constraint", "CHECK (((a AND b) AND c))", "CHECK ((a AND b AND c))"),
        ("constraint", "CHECK (((a OR b) OR c))", "CHECK ((a OR b OR c))"),
        ("index", "(ARRAY['a'::character varying,'b'::character varying])::text[]",
         "ARRAY[('a'::character varying)::text,('b'::character varying)::text]"),
    ]
    negative = [
        ("constraint", "CHECK ((a OR b) AND c)", "CHECK (a OR (b AND c))"),
        ("constraint", "CHECK (a AND b) NOT VALID", "CHECK (a AND b)"),
        ("index", "ARRAY['a','b']", "ARRAY['b','a']"),
        ("index", "(ARRAY['abc'::character varying(3)])::text[]",
         "ARRAY[('abc'::character varying)::text]"),
        ("index", "'a b'::text", "'a  b'::text"),
        ("constraint", "CHECK (((a+b)*c)>0)", "CHECK ((a+(b*c))>0)"),
    ]
    for kind, left, right in positive:
        require(normalize_sql(kind, left)[0] == normalize_sql(kind, right)[0], "positive_control_failed")
    for kind, left, right in negative:
        require(normalize_sql(kind, left)[0] != normalize_sql(kind, right)[0], "negative_control_failed")
    unsupported = [("constraint", "CHECK (a BETWEEN 1 AND 2)"), ("index", "SELECT $$a$$")]
    for kind, sql in unsupported:
        try:
            normalize_sql(kind, sql)
        except VerificationError:
            continue
        raise VerificationError("unsupported_control_failed")
    return {"positive": len(positive), "negative": len(negative),
            "unsupported": len(unsupported), "status": "PASS"}


def verify(raw):
    require(sha256(raw) == EXPECTED_INPUT_SHA256, "unreviewed_input_checksum")
    text = raw.decode("utf-8")
    require(UNSAFE.search(text) is None, "unsafe_input_pattern")
    artifact = json.loads(text)
    require(artifact.get("version") == 1 and isinstance(artifact.get("pairs"), list), "unexpected_input_shape")
    require(len(artifact["pairs"]) == 137, "unexpected_pair_count")
    seen, kinds, classes = set(), Counter(), Counter()
    results, exceptions, array_total = [], [], 0
    for pair in artifact["pairs"]:
        kind, name = pair["kind"], pair["name"]
        require((kind, name) not in seen, "duplicate_object")
        seen.add((kind, name))
        if kind == "extension":
            require(name == "pg_graphql" and pair["source"] == "1.5.11"
                    and pair["dev"] == "1.6.2", "unexpected_managed_version_difference")
            exceptions.append({"kind": kind, "name": name, "sourceVersion": pair["source"],
                               "devVersion": pair["dev"], "automaticallyApproved": False,
                               "status": "REQUIRES_EXPLICIT_MANAGED_VERSION_ACCEPTANCE"})
            continue
        require(kind in EXPECTED_KINDS, "unsupported_object_kind")
        source, source_tokens, rewrites, flattened = normalize_sql(kind, pair["source"])
        dev, dev_tokens, dev_rewrites, dev_flattened = normalize_sql(kind, pair["dev"])
        require(source == dev, "unexpected_normalized_definition_difference")
        if kind == "trigger":
            require(pair.get("sourceEnabled") == pair.get("devEnabled") == "O", "unexpected_trigger_enabled_state")
        if source_tokens == dev_tokens:
            classification = "literal_array_cast_distribution"
            require(rewrites > 0 and dev_rewrites == 0, "unexpected_format_only_pair")
        else:
            require(kind == "constraint", "unexpected_non_constraint_boolean_difference")
            operators = [op for op in ("AND", "OR") if flattened[op] != dev_flattened[op]]
            require(len(operators) == 1, "unexpected_boolean_reassociation")
            classification = operators[0].lower() + "_associativity"
            if rewrites:
                classification = "literal_array_cast_distribution_and_" + classification
        payload = {"normalizer": NORMALIZER_VERSION, "kind": kind, "name": name, "definition": source}
        if kind == "trigger":
            payload["enabled"] = pair["sourceEnabled"]
        results.append({"kind": kind, "name": name, "classification": classification,
                        "sourceRawSha256": sha256(pair["source"]), "devRawSha256": sha256(pair["dev"]),
                        "normalizedSha256": sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"))),
                        "sourceArrayCastDistributions": rewrites})
        kinds[kind] += 1
        classes[classification] += 1
        array_total += rewrites
    require(dict(kinds) == EXPECTED_KINDS, "unexpected_kind_counts")
    require(dict(classes) == EXPECTED_CLASSES, "unexpected_transformation_counts")
    require(array_total == 109 and len(exceptions) == 1, "unexpected_review_scope")
    return {"version": 1, "normalizer": NORMALIZER_VERSION, "inputSha256": sha256(raw),
            "scopeStatus": "PASS", "scopeObjects": len(results), "counts": dict(kinds),
            "classificationCounts": dict(classes), "sourceArrayCastDistributions": array_total,
            "managedVersionExceptions": exceptions, "overallSchemaParityApproved": False,
            "objects": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run in-memory controls without writing a report")
    args = parser.parse_args()
    controls = self_test()
    if args.self_test:
        print(json.dumps({"selfTests": controls}, sort_keys=True))
        return 0
    directory = Path(__file__).resolve().parent
    source_path = directory / "schema-reparse-diffs.safe.json"
    result_path = directory / "reparse-equivalence.safe.json"
    require(not source_path.is_symlink() and not result_path.is_symlink(), "unexpected_symlink")
    raw = source_path.read_bytes()
    result = verify(raw)
    result["verifierSha256"] = sha256(Path(__file__).read_bytes())
    result["selfTests"] = controls
    require(source_path.read_bytes() == raw, "input_changed_during_verification")
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"scopeStatus": result["scopeStatus"], "scopeObjects": result["scopeObjects"],
                      "counts": result["counts"], "classificationCounts": result["classificationCounts"],
                      "managedVersionExceptions": len(result["managedVersionExceptions"]),
                      "automaticallyApprovedExceptions": 0, "selfTests": controls}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(json.dumps({"scopeStatus": "FAIL", "errorCode": str(error)}, sort_keys=True))
        raise SystemExit(2)
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        print(json.dumps({"scopeStatus": "FAIL", "errorCode": "input_or_report_error"}, sort_keys=True))
        raise SystemExit(2)
