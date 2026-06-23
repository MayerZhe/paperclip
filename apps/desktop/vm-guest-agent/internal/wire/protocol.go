// Package wire implements the binary wire format for vsock RPC communication.
//
// Wire format:
//
//	4 bytes msg_len (big-endian, total message length)
//	1 byte  msg_type (0=request, 1=response, 2=event)
//	2 bytes method_id (big-endian)
//	JSON payload (remaining bytes)
package wire

import (
	"encoding/binary"
	"fmt"
)

const (
	// HeaderLen is the fixed header size: 4 (msg_len) + 1 (msg_type) + 2 (method_id)
	HeaderLen = 7

	MsgTypeRequest  byte = 0
	MsgTypeResponse byte = 1
	MsgTypeEvent    byte = 2
)

// Encode serializes a message into the binary wire format.
// msgType: 0=request, 1=response, 2=event
// methodID: RPC method identifier (1-65535)
// payload: JSON payload bytes
func Encode(msgType byte, methodID uint16, payload []byte) ([]byte, error) {
	totalLen := HeaderLen + len(payload)
	if totalLen > 1<<24 {
		return nil, fmt.Errorf("message too large: %d bytes", totalLen)
	}

	buf := make([]byte, totalLen)
	binary.BigEndian.PutUint32(buf[0:4], uint32(totalLen))
	buf[4] = msgType
	binary.BigEndian.PutUint16(buf[5:7], methodID)
	copy(buf[7:], payload)
	return buf, nil
}

// Decode parses a complete binary wire message into its components.
// Returns an error if the data is too short or msg_len doesn't match.
func Decode(data []byte) (msgType byte, methodID uint16, payload []byte, err error) {
	if len(data) < HeaderLen {
		return 0, 0, nil, fmt.Errorf("message too short: %d bytes (minimum %d)", len(data), HeaderLen)
	}

	msgLen := binary.BigEndian.Uint32(data[0:4])
	if int(msgLen) != len(data) {
		return 0, 0, nil, fmt.Errorf("msg_len %d does not match data length %d", msgLen, len(data))
	}

	msgType = data[4]
	methodID = binary.BigEndian.Uint16(data[5:7])
	payload = data[7:]
	return msgType, methodID, payload, nil
}

// ReadMessage extracts the first complete message from a byte stream,
// returning the parsed message fields and any remaining bytes.
// Useful for reading from a streaming vsock connection where multiple
// messages may arrive in a single read or a single message may span reads.
func ReadMessage(data []byte) (msgType byte, methodID uint16, payload []byte, remainder []byte, err error) {
	if len(data) < HeaderLen {
		return 0, 0, nil, nil, fmt.Errorf("incomplete header: %d bytes", len(data))
	}

	msgLen := binary.BigEndian.Uint32(data[0:4])
	if len(data) < int(msgLen) {
		return 0, 0, nil, nil, fmt.Errorf("incomplete message: need %d bytes, have %d", msgLen, len(data))
	}

	msgType, methodID, payload, err = Decode(data[:msgLen])
	if err != nil {
		return 0, 0, nil, nil, err
	}

	remainder = data[msgLen:]
	return msgType, methodID, payload, remainder, nil
}
