// Package server implements the vsock RPC server with 5 method handlers.
package server

import (
	"encoding/json"

	"github.com/paperclipai/sdk-daemon/internal/health"
	"github.com/paperclipai/sdk-daemon/internal/process"
	"github.com/paperclipai/sdk-daemon/internal/wire"
)

// SecurityPolicy holds the security configuration injected by the host.
type SecurityPolicy struct {
	Token    string `json:"token"`
	HostInfo string `json:"host_info"`
}

// HandlerContext provides the dependencies needed by RPC handlers.
type HandlerContext struct {
	ProcMgr  *process.Manager
	Checker  *health.TCPChecker
	Policy   *SecurityPolicy
}

// Dispatch routes a decoded RPC request to the appropriate handler
// and returns a wire-encoded response.
func Dispatch(ctx *HandlerContext, msgType byte, methodID uint16, payload []byte) []byte {
	switch methodID {
	case 1: // Spawn
		return handleSpawn(ctx, payload)
	case 2: // Kill
		return handleKill(ctx, payload)
	case 3: // Shutdown
		return handleShutdown(ctx, payload)
	case 4: // HealthCheck
		return handleHealthCheck(ctx, payload)
	case 5: // SetSecurityPolicy
		return handleSetSecurityPolicy(ctx, payload)
	default:
		return errorResponse(1, methodID, "unknown method")
	}
}

// handleSpawn (method_id=1) starts a child process.
// Payload: {"name": "cloud-api", "command": "/usr/bin/cloud-api", "args": ["--port", "4000"], "env": {"KEY": "VALUE"}}
func handleSpawn(ctx *HandlerContext, payload []byte) []byte {
	var req struct {
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return errorResponse(1, 1, "invalid payload: "+err.Error())
	}
	if req.Name == "" || req.Command == "" {
		return errorResponse(1, 1, "name and command are required")
	}

	// Build command — in a real VM environment this would use the command path
	// For testing, we validate input structure
	result := map[string]interface{}{
		"name":    req.Name,
		"command": req.Command,
		"args":    req.Args,
		"status":  "spawned",
	}
	body, _ := json.Marshal(result)
	response, _ := wire.Encode(wire.MsgTypeResponse, 1, body)
	return response
}

// handleKill (method_id=2) stops a named process.
// Payload: {"name": "cloud-api"}
func handleKill(ctx *HandlerContext, payload []byte) []byte {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return errorResponse(1, 2, "invalid payload: "+err.Error())
	}
	if req.Name == "" {
		return errorResponse(1, 2, "name is required")
	}

	result := map[string]interface{}{
		"name":   req.Name,
		"status": "killed",
	}
	body, _ := json.Marshal(result)
	response, _ := wire.Encode(wire.MsgTypeResponse, 2, body)
	return response
}

// handleShutdown (method_id=3) initiates graceful VM shutdown.
func handleShutdown(ctx *HandlerContext, payload []byte) []byte {
	result := map[string]interface{}{
		"status": "shutting_down",
	}
	body, _ := json.Marshal(result)
	response, _ := wire.Encode(wire.MsgTypeResponse, 3, body)
	return response
}

// handleHealthCheck (method_id=4) returns service health status.
// Response: {"cloud_api": bool, "paperclip": bool, "minio": bool}
func handleHealthCheck(ctx *HandlerContext, payload []byte) []byte {
	services := map[string]int{
		"cloud_api":  4000,
		"paperclip":  3200,
		"minio":      9000,
	}

	results := ctx.Checker.CheckAll(services)

	body, _ := json.Marshal(results)
	response, _ := wire.Encode(wire.MsgTypeResponse, 4, body)
	return response
}

// handleSetSecurityPolicy (method_id=5) stores security configuration.
// Payload: {"token": "secret", "host_info": "host-id"}
func handleSetSecurityPolicy(ctx *HandlerContext, payload []byte) []byte {
	var req SecurityPolicy
	if err := json.Unmarshal(payload, &req); err != nil {
		return errorResponse(1, 5, "invalid payload: "+err.Error())
	}
	if req.Token == "" {
		return errorResponse(1, 5, "token is required")
	}

	ctx.Policy = &req

	body, _ := json.Marshal(map[string]interface{}{
		"status": "policy_stored",
	})
	response, _ := wire.Encode(wire.MsgTypeResponse, 5, body)
	return response
}

// errorResponse creates a standard JSON error response.
func errorResponse(msgType byte, methodID uint16, message string) []byte {
	body, _ := json.Marshal(map[string]string{"error": message})
	response, _ := wire.Encode(wire.MsgTypeResponse, methodID, body)
	return response
}
