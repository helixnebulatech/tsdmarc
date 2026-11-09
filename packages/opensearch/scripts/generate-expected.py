"""Record the HTTP requests parsedmarc.opensearch sends, for tsdmarc's tests.

Runs parsedmarc's OpenSearch output (opensearch-py 3 and its bundled DSL)
against a fake transport that answers every request and records the method,
path, query string and JSON body. The cases cover every report in fixtures/
plus hand-built edge cases. tsdmarc's tests replay the same inputs and must
send the same requests.

Usage (from the repo root, with the .venv and upstream/ of the plan):
    TZ=UTC .venv/bin/python -I packages/opensearch/scripts/generate-expected.py
Set PARSEDMARC_SOURCE to parsedmarc's checkout if it is not upstream/parsedmarc.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "fixtures"
UPSTREAM = ROOT / "upstream" / "parsedmarc"
LARGE_CASE_REQUESTS = 40
LARGE_CASE_KEEP = 8
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "test" / "expected.json"


class Recorder:
    """Fake server: records requests and returns canned responses."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.exists: dict[str, bool] = {}
        self.search_hits = 0
        self.count = 0
        self.field_mapping: dict[str, Any] | None = None
        self.scroll_pages: list[list[dict[str, Any]]] = []
        # Data streams GET _data_stream/<name> lists; None answers 404.
        self.data_streams: list[str] | None = None

    def respond(self, method: str, path: str, params: dict[str, str]) -> tuple[int, Any]:
        parts = [p for p in path.split("/") if p]
        if method == "HEAD":
            return (200 if self.exists.get(parts[0], False) else 404), None
        if parts and parts[-1] == "_search" and "scroll" in params:
            hits = self.scroll_pages.pop(0) if self.scroll_pages else []
            return 200, {
                "_scroll_id": "scroll-1",
                "_shards": {"total": 1, "successful": 1, "skipped": 0, "failed": 0},
                "hits": {"hits": hits},
            }
        if parts[:2] == ["_search", "scroll"]:
            if method == "DELETE":
                return 200, {"succeeded": True, "num_freed": 1}
            hits = self.scroll_pages.pop(0) if self.scroll_pages else []
            return 200, {
                "_scroll_id": "scroll-1",
                "_shards": {"total": 1, "successful": 1, "skipped": 0, "failed": 0},
                "hits": {"hits": hits},
            }
        if parts and parts[-1] == "_search":
            hits = [
                {"_index": "x", "_id": str(i), "_source": {}}
                for i in range(self.search_hits)
            ]
            return 200, {
                "took": 1,
                "timed_out": False,
                "_shards": {"total": 1, "successful": 1, "skipped": 0, "failed": 0},
                "hits": {
                    "total": {"value": self.search_hits, "relation": "eq"},
                    "hits": hits,
                },
            }
        if parts and parts[-1] == "_count":
            return 200, {"count": self.count}
        if parts and parts[-1] == "_update_by_query":
            return 200, {"task": "node:1"}
        if len(parts) >= 3 and parts[-3] == "_mapping" and parts[-2] == "field":
            return 200, self.field_mapping or {parts[0]: {"mappings": {}}}
        if parts and parts[0] == "_data_stream":
            if method == "PUT":
                return 200, {"acknowledged": True}
            if self.data_streams is None:
                return 404, {"error": {"type": "index_not_found_exception"}, "status": 404}
            return 200, {"data_streams": [{"name": name} for name in self.data_streams]}
        if parts and parts[0] == "_index_template" and method == "PUT":
            return 200, {"acknowledged": True}
        if parts and parts[-1] == "_bulk":
            return 200, {"took": 1, "errors": False, "items": []}
        if parts and parts[-1] == "_doc":
            return 201, {"_index": parts[0], "_id": "1", "result": "created"}
        if parts and parts[-1] == "_mapping":
            return 200, {"acknowledged": True}
        if method in ("PUT", "DELETE") and len(parts) == 1:
            return 200, {"acknowledged": True}
        raise AssertionError(f"unexpected request {method} {path}")


RECORDER = Recorder()


def install_fake_transport() -> None:
    from opensearchpy.transport import Transport

    def perform_request(self, method, url, params=None, body=None, timeout=None,
                        ignore=(), headers=None):
        method, params, body, ignore, timeout = self._resolve_request_args(
            method, params, body, ignore, timeout
        )
        split = urlsplit(url)
        recorded: dict[str, Any] = {"method": method, "path": split.path}
        query = {
            k: v.decode() if isinstance(v, bytes) else str(v)
            for k, v in (params or {}).items()
        }
        if query:
            recorded["params"] = query
        if body is not None:
            text = body.decode() if isinstance(body, bytes) else body
            lines = [line for line in text.split("\n") if line]
            if split.path.endswith("_bulk"):
                recorded["body"] = [json.loads(line) for line in lines]
            else:
                recorded["body"] = json.loads(text)
        RECORDER.requests.append(recorded)
        status, response = RECORDER.respond(method, split.path, query)
        if method == "HEAD":
            return 200 <= status < 300
        if status >= 400:
            from opensearchpy.exceptions import NotFoundError
            raise NotFoundError(status, "not found", response)
        return response

    Transport.perform_request = perform_request


def run(name: str, func, *args, setup=None, **kwargs) -> dict[str, Any]:
    """Run one case. *setup* sets Recorder attributes (the cluster state)."""
    global RECORDER
    RECORDER = Recorder()
    for key, value in (setup or {}).items():
        setattr(RECORDER, key, copy.deepcopy(value))
    case: dict[str, Any] = {"name": name, "cluster": setup or {}}
    from parsedmarc import elastic, opensearch

    elastic._READY_DATA_STREAMS.clear()
    opensearch._READY_DATA_STREAMS.clear()
    try:
        func(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - recorded as the expected outcome
        case["error"] = {"type": type(error).__name__, "message": str(error)}
    case["requests"] = RECORDER.requests
    return case


def fixture_reports(kind: str) -> list[tuple[str, dict[str, Any]]]:
    reports = []
    for path in sorted((FIXTURES / kind).glob("*.json")):
        data = json.loads(path.read_text())
        if "result" in data:
            reports.append((path.name, data["result"]["report"]))
    return reports


def main() -> int:
    if os.environ.get("TZ") != "UTC":
        os.environ["TZ"] = "UTC"
        time.tzset()
    # parsedmarc's tests module provides the reports its own tests use.
    sys.path.insert(0, os.environ.get("PARSEDMARC_SOURCE", str(UPSTREAM)))
    install_fake_transport()

    from parsedmarc import opensearch as elastic
    from tests import test_opensearch as t

    elastic.set_hosts("localhost:9200")

    hit = {"search_hits": 1}

    def exists(*names: str) -> dict[str, Any]:
        return {"exists": {name: True for name in names}}

    cases: list[dict[str, Any]] = []
    save = {
        "aggregate": elastic.save_aggregate_report_to_opensearch,
        "failure": elastic.save_failure_report_to_opensearch,
        "smtp_tls": elastic.save_smtp_tls_report_to_opensearch,
    }

    for kind, func in save.items():
        for name, report in fixture_reports(kind):
            case = run(f"{kind}/{name}", func, copy.deepcopy(report))
            # The report itself is read from fixtures/ by the tests.
            case.update(kind=kind, fixture=f"{kind}/{name}", options={})
            requests = case["requests"]
            if len(requests) > LARGE_CASE_REQUESTS:
                # Keep big cases small: the head and tail, plus the total.
                case["request_count"] = len(requests)
                case["requests"] = requests[:LARGE_CASE_KEEP]
                case["last_requests"] = requests[-LARGE_CASE_KEEP:]
            cases.append(case)

    def add(name: str, kind: str, report: dict[str, Any], options=None, setup=None):
        options = options or {}
        case = run(name, save[kind], copy.deepcopy(report), setup=setup, **options)
        case.update(kind=kind, report=report, options=options)
        cases.append(case)

    aggregate = t._aggregate_report()
    add("aggregate/helper", "aggregate", aggregate)
    add("aggregate/helper exists", "aggregate", aggregate, setup=exists("dmarc_aggregate-2024-01-15"))
    add("aggregate/helper monthly", "aggregate", aggregate, {"monthly_indexes": True})
    add(
        "aggregate/helper prefix suffix shards",
        "aggregate",
        aggregate,
        {
            "index_suffix": "tenant_a",
            "index_prefix": "customer1_",
            "number_of_shards": 3,
            "number_of_replicas": 2,
        },
    )
    add("aggregate/helper already saved", "aggregate", aggregate, setup=hit)
    two = t._aggregate_report()
    two["records"].append(copy.deepcopy(two["records"][0]))
    two["records"][1]["interval_begin"] = "2024-01-16 00:00:00"
    two["records"][1]["interval_end"] = "2024-01-17 00:00:00"
    two["records"][1]["normalized_timespan"] = True
    two["records"][1]["policy_evaluated"]["dkim"] = "fail"
    two["records"][1]["policy_evaluated"]["spf"] = "FAIL"
    two["records"][1]["policy_evaluated"]["policy_override_reasons"] = []
    two["records"][1]["source"]["ip_address"] = "2001:DB8:0:0:0:0:0:1"
    two["records"][1]["auth_results"] = {
        "dkim": [
            {"domain": "example.net", "selector": "net1", "result": "fail", "human_result": None},
            {"domain": "example.org", "selector": "org1", "result": "pass", "human_result": "good"},
        ],
        "spf": [],
    }
    add("aggregate/two records", "aggregate", two)
    pct = t._aggregate_report()
    pct["policy_published"].update(pct="100", fo="1:d")
    pct["report_metadata"]["errors"] = ["something odd"]
    pct["report_metadata"]["org_extra_contact_info"] = "https://example.com"
    pct["xml_namespace"] = "urn:ietf:params:xml:ns:dmarc-2.0"
    del pct["policy_published"]["np"]
    del pct["report_metadata"]["generator"]
    add("aggregate/pct string and missing optionals", "aggregate", pct)
    bad_ip = t._aggregate_report()
    bad_ip["records"][0]["source"]["ip_address"] = "not-an-ip"
    add("aggregate/invalid ip", "aggregate", bad_ip)
    streams = {"use_data_streams": True}
    add("aggregate/helper data stream", "aggregate", aggregate, streams)
    add(
        "aggregate/helper data stream prefix suffix monthly shards",
        "aggregate",
        aggregate,
        {
            **streams,
            "index_suffix": "tenant_a",
            "index_prefix": "cust_",
            "monthly_indexes": True,
            "number_of_shards": 3,
            "number_of_replicas": 2,
        },
    )
    add("aggregate/two records data stream", "aggregate", two, streams)
    add(
        "aggregate/helper existing data stream",
        "aggregate",
        aggregate,
        streams,
        setup={"data_streams": ["dmarc_aggregate"]},
    )
    add(
        "aggregate/helper data stream name held by an index",
        "aggregate",
        aggregate,
        streams,
        setup={"data_streams": [], **exists("dmarc_aggregate")},
    )
    add(
        "aggregate/helper data stream name held by an alias",
        "aggregate",
        aggregate,
        streams,
        setup=exists("dmarc_aggregate"),
    )
    add("aggregate/helper data stream already saved", "aggregate", aggregate, streams, setup=hit)
    offset = t._aggregate_report()
    offset["report_metadata"]["begin_date"] = "2024-01-15 01:00:00+01:00"
    add("aggregate/offset dates", "aggregate", offset)

    failure = t._failure_report()
    add("failure/helper", "failure", failure)
    add("failure/helper monthly prefix suffix", "failure", failure, {
        "monthly_indexes": True, "index_suffix": "tenant_a", "index_prefix": "cust_",
    })
    add("failure/helper already saved", "failure", failure, setup=hit)
    add("failure/helper data stream", "failure", failure, {**streams, "monthly_indexes": True})
    add("failure/helper data stream prefix suffix", "failure", failure, {
        **streams, "index_suffix": "tenant_a", "index_prefix": "cust_",
    })
    rich = t._failure_report()
    rich["parsed_sample"]["headers"]["To"] = [["RT", "rcpt@example.com"]]
    rich["parsed_sample"]["headers"]["From"] = [["", "sender@example.com"]]
    rich["parsed_sample"]["headers"]["Reply-To"] = [["Real One", "real@phish.example"]]
    rich["parsed_sample"]["headers"]["X-Empty"] = ""
    rich["parsed_sample"]["headers"]["X-None"] = None
    rich["parsed_sample"]["headers"]["X-List"] = []
    rich["parsed_sample"]["headers"]["X-Dict"] = {}
    rich["parsed_sample"]["headers"]["X-Nested"] = {"a": None, "b": "c", "d": []}
    rich["parsed_sample"]["reply_to"] = [{"display_name": "Real One", "address": "real@phish.example"}]
    rich["parsed_sample"]["cc"] = [{"display_name": "CC", "address": "cc@example.com"}]
    rich["parsed_sample"]["bcc"] = [{"display_name": "", "address": "bcc@example.com"}]
    rich["parsed_sample"]["attachments"] = [
        {"filename": "a.pdf", "mail_content_type": "application/pdf", "sha256": "deadbeef"}
    ]
    rich["authentication_mechanisms"] = ["dkim"]
    rich["source"]["ip_address"] = "::ffff:192.0.2.5"
    add("failure/rich sample", "failure", rich)
    no_reply_name = t._failure_report()
    no_reply_name["parsed_sample"]["headers"]["Reply-To"] = [["", "noname@phish.example"]]
    del no_reply_name["parsed_sample"]["headers"]["Subject"]
    no_reply_name["parsed_sample"]["date"] = None
    add("failure/reply-to without name, no subject, no date", "failure", no_reply_name)
    missing = t._failure_report()
    del missing["feedback_type"]
    add("failure/missing feedback_type", "failure", missing)

    smtp = t._smtp_tls_report()
    add("smtp_tls/helper", "smtp_tls", smtp)
    add("smtp_tls/helper monthly prefix suffix", "smtp_tls", smtp, {
        "monthly_indexes": True, "index_suffix": "t1", "index_prefix": "cust_",
    })
    add("smtp_tls/helper already saved", "smtp_tls", smtp, setup=hit)
    add("smtp_tls/helper data stream", "smtp_tls", smtp, streams)
    add("smtp_tls/helper data stream prefix", "smtp_tls", smtp, {**streams, "index_prefix": "cust_"})
    add(
        "smtp_tls/helper data stream name collision",
        "smtp_tls",
        smtp,
        streams,
        setup=exists("smtp_tls"),
    )
    bare = t._smtp_tls_report()
    for policy in bare["policies"]:
        policy.pop("policy_strings", None)
        policy.pop("mx_host_patterns", None)
        policy.pop("failure_details", None)
    add("smtp_tls/policy without optionals", "smtp_tls", bare)
    full = t._smtp_tls_report()
    full["policies"][0]["failure_details"] = [
        {
            "result_type": "certificate-expired",
            "failed_session_count": 1,
            "receiving_mx_hostname": "mx.example.com",
            "additional_information_uri": "https://example.com/why",
            "failure_reason_code": "ERR_CERT",
            "ip_address": "10.0.0.5",
            "receiving_ip": "10.0.0.2",
            "receiving_mx_helo": "mx.helo.example.com",
            "sending_mta_ip": "10.0.0.1",
        },
        {"result_type": "starttls-not-supported", "failed_session_count": 2,
         "additional_info_uri": "https://example.com/info"},
    ]
    full["contact_info"] = ["a@example.com", "b@example.com"]
    full["policies"].append({
        "policy_domain": "example.net", "policy_type": "tlsa",
        "successful_session_count": 50, "failed_session_count": 0,
    })
    add("smtp_tls/all optional failure fields", "smtp_tls", full)

    others: list[dict[str, Any]] = []

    def other(name: str, func, *args, setup=None, **kwargs):
        case = run(name, func, *args, setup=setup, **kwargs)
        case.update(args=list(args), options=kwargs)
        others.append(case)

    other("create_indexes default", elastic.create_indexes, ["dmarc_aggregate-2024-01-15"])
    other("create_indexes custom", elastic.create_indexes, ["idx"],
          settings={"number_of_shards": 3, "refresh_interval": "5s"})
    other("create_indexes existing", elastic.create_indexes, ["idx"], setup=exists("idx"))

    other("create_data_streams default", elastic.create_data_streams, ["dmarc_aggregate"])
    other("create_data_streams custom", elastic.create_data_streams, ["smtp_tls"],
          settings={"number_of_shards": 3, "refresh_interval": "5s"})
    other("create_data_streams existing", elastic.create_data_streams, ["dmarc_failure"],
          setup={"data_streams": ["dmarc_failure"]})
    other("create_data_streams collision", elastic.create_data_streams, ["dmarc_failure"],
          setup={"data_streams": [], **exists("dmarc_failure")})

    def count(n: int) -> dict[str, Any]:
        return {"count": n}

    other("migrate aggregate backfill", elastic.migrate_indexes,
          aggregate_indexes=["dmarc_aggregate"], setup=count(42))
    other("migrate aggregate nothing to do", elastic.migrate_indexes,
          aggregate_indexes=["dmarc_aggregate"], setup=count(0))
    other("migrate smtp tls backfill", elastic.migrate_indexes,
          smtp_tls_indexes=["smtp_tls"], setup=count(7))
    other("migrate nothing", elastic.migrate_indexes)

    def legacy(fo_type: str | None, v2_exists: bool, pages: int) -> dict[str, Any]:
        setup: dict[str, Any] = {
            "exists": {"dmarc_aggregate": True, "dmarc_aggregate-v2": v2_exists},
            "scroll_pages": [
                [
                    {"_index": "dmarc_aggregate", "_id": f"doc-{page}-{i}",
                     "_source": {"org_name": f"Org {page}-{i}"}}
                    for i in range(2)
                ]
                for page in range(pages)
            ],
        }
        if fo_type is not None:
            setup["field_mapping"] = t._typeless_fo_mapping("dmarc_aggregate", fo_type)
        return setup

    other("migrate legacy fo long", elastic.migrate_indexes,
          legacy_fo_indexes=["dmarc_aggregate"], setup=legacy("long", False, 2))
    other("migrate legacy fo long with leftover v2", elastic.migrate_indexes,
          legacy_fo_indexes=["dmarc_aggregate"], setup=legacy("long", True, 1))
    other("migrate legacy fo text", elastic.migrate_indexes,
          legacy_fo_indexes=["dmarc_aggregate"], setup=legacy("text", False, 0))
    other("migrate legacy fo unmapped", elastic.migrate_indexes,
          legacy_fo_indexes=["dmarc_aggregate"], setup=legacy(None, False, 0))
    other("migrate legacy fo missing index", elastic.migrate_indexes,
          legacy_fo_indexes=["missing"])

    mappings = {
        "aggregate": elastic._AggregateReportDoc._doc_type.mapping.to_dict(),
        "failure": elastic._FailureReportDoc._doc_type.mapping.to_dict(),
        "smtp_tls": elastic._SMTPTLSReportDoc._doc_type.mapping.to_dict(),
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps({"saves": cases, "others": others, "mappings": mappings}, indent=1, ensure_ascii=False)
        + "\n"
    )
    print(f"Wrote {len(cases)} save cases and {len(others)} other cases to {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
