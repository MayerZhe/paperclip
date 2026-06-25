package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/paperclipai/sdk-daemon/internal/health"
	"github.com/paperclipai/sdk-daemon/internal/process"
	"github.com/paperclipai/sdk-daemon/internal/wire"
)

func newTestContext() *HandlerContext {
	return &HandlerContext{
		ProcMgr: process.NewManager(),
		Checker: &health.TCPChecker{
			Host:    "127.0.0.1",
			Timeout: 1 * time.Second,
		},
	}
}

func decodeResponse(t *testing.T, data []byte) (byte, uint16, map[string]interface{}) {
	t.Helper()
	msgType, methodID, body, err := wire.Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("json.Unmarshal error = %v", err)
	}
	return msgType, methodID, result
}

// ─── Spawn (method_id=1) ───

func TestHandleSpawnValid(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]interface{}{
		"name":    "test-service",
		"command": "/usr/bin/test-service",
		"args":    []string{"--port", "8080"},
		"env":     map[string]string{"KEY": "VALUE"},
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 1, payload)
	msgType, methodID, result := decodeResponse(t, response)

	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 1 {
		t.Errorf("methodID = %d, want 1", methodID)
	}
	if result["name"] != "test-service" {
		t.Errorf("name = %v, want test-service", result["name"])
	}
	if result["command"] != "/usr/bin/test-service" {
		t.Errorf("command = %v, want /usr/bin/test-service", result["command"])
	}
	if result["status"] != "spawned" {
		t.Errorf("status = %v, want spawned", result["status"])
	}
}

func TestHandleSpawnMissingName(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{
		"command": "/usr/bin/test",
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 1, payload)
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for missing name")
	}
}

func TestHandleSpawnMissingCommand(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{
		"name": "test",
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 1, payload)
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for missing command")
	}
}

func TestHandleSpawnInvalidJSON(t *testing.T) {
	ctx := newTestContext()
	response := Dispatch(ctx, wire.MsgTypeRequest, 1, []byte("not-json"))
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for invalid JSON")
	}
}

// ─── Kill (method_id=2) ───

func TestHandleKillValid(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{
		"name": "test-service",
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 2, payload)
	msgType, methodID, result := decodeResponse(t, response)

	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 2 {
		t.Errorf("methodID = %d, want 2", methodID)
	}
	if result["status"] != "killed" {
		t.Errorf("status = %v, want killed", result["status"])
	}
}

func TestHandleKillMissingName(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{})

	response := Dispatch(ctx, wire.MsgTypeRequest, 2, payload)
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for missing name")
	}
}

// ─── Shutdown (method_id=3) ───

func TestHandleShutdown(t *testing.T) {
	ctx := newTestContext()
	response := Dispatch(ctx, wire.MsgTypeRequest, 3, []byte("{}"))
	msgType, methodID, result := decodeResponse(t, response)

	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 3 {
		t.Errorf("methodID = %d, want 3", methodID)
	}
	if result["status"] != "shutting_down" {
		t.Errorf("status = %v, want shutting_down", result["status"])
	}
}

// ─── HealthCheck (method_id=4) ───

func TestHandleHealthCheck(t *testing.T) {
	ctx := newTestContext()
	response := Dispatch(ctx, wire.MsgTypeRequest, 4, []byte("{}"))
	msgType, methodID, result := decodeResponse(t, response)

	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 4 {
		t.Errorf("methodID = %d, want 4", methodID)
	}

	// Verify all three keys exist
	requiredKeys := []string{"cloud_api", "paperclip", "minio"}
	for _, key := range requiredKeys {
		if _, ok := result[key]; !ok {
			t.Errorf("health check response missing key: %s", key)
		}
	}

	// In test environment, ports should be closed
	if result["cloud_api"] != false {
		t.Logf("cloud_api = %v (expected false in test environment)", result["cloud_api"])
	}
}

// ─── SetSecurityPolicy (method_id=5) ───

func TestHandleSetSecurityPolicyValid(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{
		"token":     "test-secret-token",
		"host_info": "test-host-001",
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 5, payload)
	msgType, methodID, result := decodeResponse(t, response)

	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 5 {
		t.Errorf("methodID = %d, want 5", methodID)
	}
	if result["status"] != "policy_stored" {
		t.Errorf("status = %v, want policy_stored", result["status"])
	}

	// Verify policy was stored
	if ctx.Policy == nil {
		t.Fatal("policy should be stored")
	}
	if ctx.Policy.Token != "test-secret-token" {
		t.Errorf("stored token = %s, want test-secret-token", ctx.Policy.Token)
	}
	if ctx.Policy.HostInfo != "test-host-001" {
		t.Errorf("stored host_info = %s, want test-host-001", ctx.Policy.HostInfo)
	}
}

func TestHandleSetSecurityPolicyMissingToken(t *testing.T) {
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{
		"host_info": "test-host",
	})

	response := Dispatch(ctx, wire.MsgTypeRequest, 5, payload)
	_, _, result := decodeResponse(t, response)

	// Token is now optional — policy_stored with a warning
	if result["status"] != "policy_stored" {
		t.Errorf("status = %v, want policy_stored", result["status"])
	}
	if result["warning"] == nil {
		t.Error("expected warning for missing token")
	}
}

func TestHandleSetSecurityPolicyInvalidJSON(t *testing.T) {
	ctx := newTestContext()
	response := Dispatch(ctx, wire.MsgTypeRequest, 5, []byte("{bad"))
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for invalid JSON")
	}
}

// ─── Unknown Method ───

func TestHandleUnknownMethod(t *testing.T) {
	ctx := newTestContext()
	response := Dispatch(ctx, wire.MsgTypeRequest, 99, []byte("{}"))
	_, _, result := decodeResponse(t, response)

	if result["error"] == nil {
		t.Error("expected error for unknown method")
	}
}

// ─── Method ID boundary checks ───

func TestMethodIDBoundaryMin(t *testing.T) {
	ctx := newTestContext()
	// method_id 0 is not a defined handler — should return error
	response := Dispatch(ctx, wire.MsgTypeRequest, 0, []byte("{}"))
	_, _, result := decodeResponse(t, response)
	if result["error"] == nil {
		t.Error("expected error for method_id 0")
	}
}

func TestMethodIDBoundaryMax(t *testing.T) {
	ctx := newTestContext()
	// method_id 65535 is not defined — should return error
	response := Dispatch(ctx, wire.MsgTypeRequest, 65535, []byte("{}"))
	_, _, result := decodeResponse(t, response)
	if result["error"] == nil {
		t.Error("expected error for method_id 65535")
	}
}

// ─── Event encoding ───

func TestReadyEventFormat(t *testing.T) {
	// The "Ready" event uses msg_type=2 (event), method_id=0
	payload := json.RawMessage(`"Ready"`)
	encoded, err := wire.Encode(wire.MsgTypeEvent, 0, payload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	msgType, methodID, body, err := wire.Decode(encoded)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if msgType != wire.MsgTypeEvent {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeEvent)
	}
	if methodID != 0 {
		t.Errorf("methodID = %d, want 0", methodID)
	}
	if string(body) != `"Ready"` {
		t.Errorf("body = %s, want \"Ready\"", body)
	}
}
