package wire

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestEncodeRequest(t *testing.T) {
	payload := json.RawMessage(`{"cmd":"spawn"}`)
	data, err := Encode(0, 1, payload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	// msg_len: 4 + 1 + 2 + len(payload) = 7 + 16 = 23
	expectedLen := 4 + 1 + 2 + len(payload)
	if len(data) != expectedLen {
		t.Errorf("Encode() length = %d, want %d", len(data), expectedLen)
	}

	// Check msg_len (big-endian at offset 0:4)
	msgLen := uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3])
	if msgLen != uint32(expectedLen) {
		t.Errorf("msg_len = %d, want %d", msgLen, expectedLen)
	}

	// Check msg_type at offset 4
	if data[4] != 0 {
		t.Errorf("msg_type = %d, want 0 (request)", data[4])
	}

	// Check method_id at offset 5:7 (big-endian)
	methodID := uint16(data[5])<<8 | uint16(data[6])
	if methodID != 1 {
		t.Errorf("method_id = %d, want 1", methodID)
	}

	// Check payload at offset 7
	if !bytes.Equal(data[7:], payload) {
		t.Errorf("payload = %s, want %s", data[7:], payload)
	}
}

func TestEncodeResponse(t *testing.T) {
	payload := json.RawMessage(`{"status":"ok"}`)
	data, err := Encode(1, 2, payload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	if data[4] != 1 {
		t.Errorf("msg_type = %d, want 1 (response)", data[4])
	}

	methodID := uint16(data[5])<<8 | uint16(data[6])
	if methodID != 2 {
		t.Errorf("method_id = %d, want 2", methodID)
	}
}

func TestEncodeEvent(t *testing.T) {
	payload := json.RawMessage(`"Ready"`)
	data, err := Encode(2, 0, payload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	if data[4] != 2 {
		t.Errorf("msg_type = %d, want 2 (event)", data[4])
	}
}

func TestDecodeValidMessage(t *testing.T) {
	payload := json.RawMessage(`{"health":"ok"}`)
	encoded, _ := Encode(1, 4, payload)

	msgType, methodID, body, err := Decode(encoded)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if msgType != 1 {
		t.Errorf("msg_type = %d, want 1", msgType)
	}
	if methodID != 4 {
		t.Errorf("method_id = %d, want 4", methodID)
	}
	if !bytes.Equal(body, payload) {
		t.Errorf("body = %s, want %s", body, payload)
	}
}

func TestDecodeMessageTooShort(t *testing.T) {
	_, _, _, err := Decode([]byte{0x00, 0x00, 0x00})
	if err == nil {
		t.Error("Decode() expected error for short message, got nil")
	}
}

func TestDecodeMsgLenMismatch(t *testing.T) {
	// msg_len claims 100 bytes but only 7 bytes provided
	data := []byte{0x00, 0x00, 0x00, 100, 0x01, 0x00, 0x04}
	_, _, _, err := Decode(data)
	if err == nil {
		t.Error("Decode() expected error for msg_len mismatch, got nil")
	}
}

func TestDecodeZeroMsgLen(t *testing.T) {
	// msg_len = 7 (header only, no payload), msg_type=1, method_id=4
	data := []byte{0x00, 0x00, 0x00, 0x07, 0x01, 0x00, 0x04}
	msgType, methodID, body, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if msgType != 1 {
		t.Errorf("msg_type = %d, want 1", msgType)
	}
	if methodID != 4 {
		t.Errorf("method_id = %d, want 4", methodID)
	}
	if len(body) != 0 {
		t.Errorf("body length = %d, want 0", len(body))
	}
}

func TestDecodeInvalidMsgType(t *testing.T) {
	payload := json.RawMessage(`{}`)
	// msg_type = 5 (invalid)
	data := []byte{0x00, 0x00, 0x00, 0x09, 0x05, 0x00, 0x01, 0x7b, 0x7d}
	_ = data
	_ = payload
	// Decode should accept all msg_types — validation is caller's responsibility
	// msg_type is just a field, no server-side rejection
	msgType, _, _, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v, but decode should succeed for any msg_type", err)
	}
	if msgType != 5 {
		t.Errorf("msg_type = %d, want 5", msgType)
	}
}

func TestReadFullMessage(t *testing.T) {
	payload := json.RawMessage(`{"test":true}`)
	encoded, _ := Encode(0, 3, payload)

	// Add extra garbage after the message to simulate stream buffering
	stream := append(encoded, 0xFF, 0xEE)

	msgType, methodID, body, remainder, err := ReadMessage(stream)
	if err != nil {
		t.Fatalf("ReadMessage() error = %v", err)
	}
	if msgType != 0 {
		t.Errorf("msg_type = %d, want 0", msgType)
	}
	if methodID != 3 {
		t.Errorf("method_id = %d, want 3", methodID)
	}
	if !bytes.Equal(body, payload) {
		t.Errorf("body = %s, want %s", body, payload)
	}
	if !bytes.Equal(remainder, []byte{0xFF, 0xEE}) {
		t.Errorf("remainder = %v, want [0xFF, 0xEE]", remainder)
	}
}

func TestReadFullMessageIncomplete(t *testing.T) {
	payload := json.RawMessage(`{"test":true}`)
	encoded, _ := Encode(0, 3, payload)

	// Truncate by 2 bytes
	truncated := encoded[:len(encoded)-2]

	_, _, _, _, err := ReadMessage(truncated)
	if err == nil {
		t.Error("ReadMessage() expected error for truncated message, got nil")
	}
}

func TestEncodeLargePayload(t *testing.T) {
	// 10KB payload
	largePayload := make([]byte, 10240)
	for i := range largePayload {
		largePayload[i] = byte(i % 256)
	}

	data, err := Encode(0, 1, largePayload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	msgType, methodID, body, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if msgType != 0 {
		t.Errorf("msg_type = %d, want 0", msgType)
	}
	if methodID != 1 {
		t.Errorf("method_id = %d, want 1", methodID)
	}
	if !bytes.Equal(body, largePayload) {
		t.Error("round-trip failed for large payload")
	}
}

func TestEncodeMethodIDBoundary(t *testing.T) {
	// Test method_id max value (65535)
	payload := json.RawMessage(`{}`)
	data, err := Encode(0, 65535, payload)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	methodID := uint16(data[5])<<8 | uint16(data[6])
	if methodID != 65535 {
		t.Errorf("method_id = %d, want 65535", methodID)
	}
}
