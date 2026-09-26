import { describe, expect, it } from "vitest";
import {
  connectorArn,
  connectorArns,
  isManagedConnectorName,
  partitionForRegion,
} from "../src/connectors.js";

describe("connectorArn", () => {
  it("expands managed connector names to regional ARNs", () => {
    expect(connectorArn("ALL_INGRESS", "us-east-1")).toBe(
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
    );
    expect(connectorArn("SHELL_INGRESS", "ap-northeast-1")).toBe(
      "arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:SHELL_INGRESS",
    );
  });

  it("uses the region's partition (gov/cn) in managed ARNs", () => {
    expect(connectorArn("ALL_INGRESS", "us-gov-west-1")).toBe(
      "arn:aws-us-gov:lambda:us-gov-west-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
    );
    expect(connectorArn("ALL_INGRESS", "cn-north-1")).toBe(
      "arn:aws-cn:lambda:cn-north-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
    );
    expect(partitionForRegion("us-east-1")).toBe("aws");
  });

  it("passes full ARNs through", () => {
    const arn = "arn:aws:lambda:us-east-1:123456789012:network-connector:mine";
    expect(connectorArn(arn, "us-east-1")).toBe(arn);
  });

  it("detects managed names vs ARNs", () => {
    expect(isManagedConnectorName("INTERNET_EGRESS")).toBe(true);
    expect(isManagedConnectorName("arn:aws:x")).toBe(false);
  });

  it("maps lists", () => {
    expect(connectorArns(["ALL_INGRESS"], "eu-west-1")).toEqual([
      "arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
    ]);
    expect(connectorArns(undefined, "eu-west-1")).toBeUndefined();
  });
});
