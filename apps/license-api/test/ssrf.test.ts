import { describe, expect, it } from "vitest";
import { DohResolver, checkTarget, isPublicAddress } from "../src/ssrf";
import { FakeResolver } from "./helpers";

describe("isPublicAddress", () => {
  const blocked = [
    "0.0.0.0", "10.0.0.5", "100.64.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.168.1.10", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250",
    "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "fec0::1", "2001:db8::1", "::ffff:7f00:1",
    "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "::7f00:1", "2002:a9fe:a9fe::1",
    "2001::1", "not-an-ip", "1.2.3", "1.2.3.256",
  ];
  const allowed = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:5db8:d822"];

  it.each(blocked)("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(allowed)("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe("checkTarget", () => {
  const resolver = new FakeResolver({
    "internal.example": { status: "ok", addresses: ["93.184.216.34", "192.168.1.10"] },
    "gone.example": { status: "nxdomain" },
    "flaky.example": { status: "error" },
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "http://api.localhost:8080/",
    "http://10.0.0.5/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://127.1/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://internal.example/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://metadata.google.internal/",
  ])("blocks %s", async (url) => {
    expect(await checkTarget(new URL(url), resolver)).toEqual({ ok: false, reason: "blocked" });
  });

  it("reports NXDOMAIN and DNS errors distinctly", async () => {
    expect(await checkTarget(new URL("https://gone.example/"), resolver)).toEqual({ ok: false, reason: "nxdomain" });
    expect(await checkTarget(new URL("https://flaky.example/"), resolver)).toEqual({ ok: false, reason: "dns_error" });
  });

  it("allows a public hostname and a public IP literal", async () => {
    expect(await checkTarget(new URL("https://www.example.com/a?b"), resolver)).toEqual({ ok: true });
    expect(await checkTarget(new URL("http://93.184.216.34/"), resolver)).toEqual({ ok: true });
  });
});

describe("DohResolver", () => {
  function doh(responses: Record<string, unknown>) {
    const seen: string[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req.url);
      expect(req.headers.get("accept")).toBe("application/dns-json");
      const u = new URL(req.url);
      const body = responses[`${u.searchParams.get("name")}/${u.searchParams.get("type")}`] ?? { Status: 0, Answer: [] };
      return Response.json(body);
    };
    return { resolver: new DohResolver(fetcher), seen };
  }

  it("collects A and AAAA answers and ignores CNAMEs", async () => {
    const { resolver, seen } = doh({
      "example.com/A": { Status: 0, Answer: [{ type: 5, data: "alias.example.net." }, { type: 1, data: "93.184.216.34" }] },
      "example.com/AAAA": { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] },
    });
    expect(await resolver.resolve("example.com")).toEqual({
      status: "ok",
      addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    });
    expect(seen.every((u) => u.startsWith("https://cloudflare-dns.com/dns-query?"))).toBe(true);
  });

  it("maps Status 3 to nxdomain and empty answers to error", async () => {
    const { resolver } = doh({ "nx.example/A": { Status: 3 }, "nx.example/AAAA": { Status: 3 } });
    expect(await resolver.resolve("nx.example")).toEqual({ status: "nxdomain" });
    const { resolver: empty } = doh({});
    expect(await empty.resolve("empty.example")).toEqual({ status: "error" });
  });

  it("maps fetch failure to error", async () => {
    const resolver = new DohResolver(async () => {
      throw new TypeError("down");
    });
    expect(await resolver.resolve("x.example")).toEqual({ status: "error" });
  });
});
