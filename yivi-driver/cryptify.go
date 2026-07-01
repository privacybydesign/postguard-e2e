package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Minimal cryptify client for the golden flow: a single-chunk upload
// (init -> PUT -> finalize) that triggers a recipient notification email, plus
// a download. Mirrors the protocol in cryptify/api-description.yaml.

func cryptifyUpload(baseURL, recipientEmail string, ciphertext []byte) (uuid string, err error) {
	// init: registers the notification recipient and returns the first token.
	initBody, _ := json.Marshal(map[string]any{
		"recipient":   recipientEmail,
		"mailContent": "golden-flow e2e test",
		"mailLang":    "EN",
		"confirm":     false,
	})
	resp, err := http.Post(baseURL+"/fileupload/init", "application/json", bytes.NewReader(initBody))
	if err != nil {
		return "", err
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("init -> %d: %s", resp.StatusCode, string(raw))
	}
	token := resp.Header.Get("cryptifytoken")
	var initR struct {
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal(raw, &initR); err != nil {
		return "", fmt.Errorf("decode init: %w (body: %s)", err, string(raw))
	}
	if initR.UUID == "" || token == "" {
		return "", fmt.Errorf("init missing uuid/token (uuid=%q token=%q)", initR.UUID, token)
	}

	// chunk: single PUT covering the whole payload.
	n := len(ciphertext)
	put, _ := http.NewRequest(http.MethodPut, baseURL+"/fileupload/"+initR.UUID, bytes.NewReader(ciphertext))
	put.Header.Set("cryptifytoken", token)
	// cryptify treats the range end as EXCLUSIVE: it requires body.len() == end-start.
	put.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/*", n))
	put.Header.Set("Content-Type", "application/octet-stream")
	putResp, err := http.DefaultClient.Do(put)
	if err != nil {
		return "", err
	}
	pb, _ := io.ReadAll(putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("chunk PUT -> %d: %s", putResp.StatusCode, string(pb))
	}
	token = putResp.Header.Get("cryptifytoken")

	// finalize: total size, sends the notification email.
	fin, _ := http.NewRequest(http.MethodPost, baseURL+"/fileupload/finalize/"+initR.UUID, nil)
	fin.Header.Set("cryptifytoken", token)
	fin.Header.Set("Content-Range", fmt.Sprintf("bytes */%d", n))
	finResp, err := http.DefaultClient.Do(fin)
	if err != nil {
		return "", err
	}
	fb, _ := io.ReadAll(finResp.Body)
	finResp.Body.Close()
	if finResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("finalize -> %d: %s", finResp.StatusCode, string(fb))
	}
	return initR.UUID, nil
}

func cryptifyDownload(baseURL, uuid string) ([]byte, error) {
	resp, err := http.Get(baseURL + "/filedownload/" + uuid)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("download -> %d: %s", resp.StatusCode, string(b))
	}
	return io.ReadAll(resp.Body)
}
