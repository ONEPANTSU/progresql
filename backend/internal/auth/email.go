package auth

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"math/big"
	"net"
	"net/smtp"
	"strings"
	"sync"
	"time"
)

func base64Encode(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

const mimeBoundary = "----=_ProgreSQL_Boundary_001"

// logoBase64 is the ProgreSQL icon (48x48 PNG) encoded as base64 for inline email embedding.
const logoBase64 = "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"

const (
	// VerificationCodeLength is the number of digits in the code.
	VerificationCodeLength = 6
	// VerificationCodeTTL is how long the code is valid.
	VerificationCodeTTL = 15 * time.Minute
	// MaxVerificationAttempts limits wrong-code tries before the code expires.
	MaxVerificationAttempts = 5
)

// VerificationCode holds a pending email verification code.
type VerificationCode struct {
	Code      string
	Email     string
	ExpiresAt time.Time
	Attempts  int
}

// EmailService sends verification emails via SMTP.
type EmailService struct {
	host     string
	port     int
	user     string
	password string
	from     string

	mu         sync.RWMutex
	codes      map[string]*VerificationCode // keyed by user ID
	resetCodes map[string]*VerificationCode // keyed by email (for password reset)
}

// NewEmailService creates a new EmailService for sending verification emails.
func NewEmailService(host string, port int, user, password, from string) *EmailService {
	return &EmailService{
		host:       host,
		port:       port,
		user:       user,
		password:   password,
		from:       from,
		codes:      make(map[string]*VerificationCode),
		resetCodes: make(map[string]*VerificationCode),
	}
}

// IsConfigured returns true if SMTP credentials are set.
func (e *EmailService) IsConfigured() bool {
	return e.user != "" && e.password != ""
}

// GenerateCode creates a verification code for the given user and email,
// stores it, and returns the code string. Does NOT send the email.
func (e *EmailService) GenerateCode(userID, email string) (string, error) {
	code, err := generateRandomCode(VerificationCodeLength)
	if err != nil {
		return "", fmt.Errorf("generating code: %w", err)
	}

	e.mu.Lock()
	e.codes[userID] = &VerificationCode{
		Code:      code,
		Email:     strings.ToLower(strings.TrimSpace(email)),
		ExpiresAt: time.Now().Add(VerificationCodeTTL),
		Attempts:  0,
	}
	e.mu.Unlock()

	return code, nil
}

// SendVerificationEmail sends a verification code email to the specified address.
func (e *EmailService) SendVerificationEmail(toEmail, code string) error {
	if !e.IsConfigured() {
		return fmt.Errorf("SMTP not configured")
	}

	msg := buildVerificationEmail(e.from, toEmail, code)

	addr := fmt.Sprintf("%s:%d", e.host, e.port)

	tlsConfig := &tls.Config{
		ServerName: e.host,
	}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	if err != nil {
		return fmt.Errorf("TLS dial %s: %w", addr, err)
	}

	client, err := smtp.NewClient(conn, e.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer func() { _ = client.Quit() }()

	auth := smtp.PlainAuth("", e.user, e.password, e.host)
	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP auth: %w", err)
	}

	if err := client.Mail(e.from); err != nil {
		return fmt.Errorf("SMTP MAIL FROM: %w", err)
	}
	if err := client.Rcpt(toEmail); err != nil {
		return fmt.Errorf("SMTP RCPT TO: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA: %w", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("writing email: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("closing email writer: %w", err)
	}

	return nil
}

// buildVerificationEmail constructs the full MIME message with headers,
// plain-text fallback, and branded HTML body.
func buildVerificationEmail(from, to, code string) string {
	ttlMinutes := int(VerificationCodeTTL.Minutes())
	subject := "ProgreSQL — Email Verification Code"

	plainBody := fmt.Sprintf(
		"Your ProgreSQL verification code: %s\r\n\r\nThe code is valid for %d minutes.\r\nIf you did not request this, please ignore this email.",
		code, ttlMinutes,
	)

	htmlBody := buildVerificationHTML(code, ttlMinutes)

	var b strings.Builder

	// Headers
	_, _ = fmt.Fprintf(&b, "From: ProgreSQL <%s>\r\n", from)
	_, _ = fmt.Fprintf(&b, "To: %s\r\n", to)
	_, _ = fmt.Fprintf(&b, "Subject: =?UTF-8?B?%s?=\r\n", base64Encode(subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("X-Mailer: ProgreSQL/1.0\r\n")
	b.WriteString("X-Priority: 3\r\n")
	b.WriteString("List-Unsubscribe: <mailto:" + from + "?subject=unsubscribe>\r\n")
	_, _ = fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n", mimeBoundary)
	b.WriteString("\r\n")

	// Plain text part
	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(plainBody)
	b.WriteString("\r\n")

	// HTML part
	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n")

	// Closing boundary
	_, _ = fmt.Fprintf(&b, "--%s--\r\n", mimeBoundary)

	return b.String()
}

// buildVerificationHTML returns the branded HTML email body with dark theme.
func buildVerificationHTML(code string, ttlMinutes int) string {
	// Split code into individual digits for styled display
	digits := make([]string, len(code))
	for i, ch := range code {
		digits[i] = fmt.Sprintf(
			`<td width="38" height="46" align="center" valign="middle" style="width:38px;height:46px;text-align:center;font-size:22px;font-weight:700;font-family:Consolas,'Courier New',monospace;color:#ffffff;background-color:#6366f1;border-radius:8px;">%c</td><td width="4" style="width:4px;"></td>`,
			ch,
		)
	}
	codeHTML := `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>` + strings.Join(digits, "") + `</tr></table>`

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>ProgreSQL Verification</title>
</head>
<body style="margin:0;padding:0;background-color:#080b12;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080b12;">
<tr><td align="center" style="padding:40px 16px;">

<!-- Main card -->
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:#0f1423;border-radius:16px;overflow:hidden;border:1px solid #1b1f3a;">

<!-- Header -->
<tr>
<td style="background-color:#0c1019;padding:28px 32px 24px;text-align:center;border-bottom:1px solid #1b1f3a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <img src="data:image/png;base64,`+logoBase64+`" alt="ProgreSQL" width="36" height="36" style="display:block;border-radius:8px;" />
      </td>
      <td style="vertical-align:middle;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">ProgreSQL</span>
      </td>
    </tr>
  </table>
</td>
</tr>

<!-- Body -->
<tr>
<td style="padding:32px;">
  <p style="margin:0 0 6px;color:#ffffff;font-size:18px;font-weight:600;">Verify your email</p>
  <p style="margin:0 0 28px;color:#9ca3af;font-size:14px;line-height:1.5;">Enter the code below in the app to complete verification.</p>

  <!-- Code digits -->
  <div style="text-align:center;margin:0 0 28px;font-size:0;">
    %s
  </div>

  <p style="margin:0 0 4px;color:#9ca3af;font-size:13px;text-align:center;">This code expires in <strong style="color:#6366f1;">%d minutes</strong>.</p>
  <p style="margin:0;color:#6b7280;font-size:12px;text-align:center;">If you didn't request this, you can safely ignore this email.</p>
</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:20px 32px;background-color:#0a0e17;border-top:1px solid #1b1f3a;text-align:center;">
  <p style="margin:0;color:#6b7280;font-size:11px;line-height:1.4;">
    This is an automated message from ProgreSQL.<br>
    Please do not reply to this email.
  </p>
</td>
</tr>

</table>
<!-- /Main card -->

</td></tr>
</table>
</body>
</html>`, codeHTML, ttlMinutes)
}

// VerifyCode checks the code for the given user. Returns nil on success.
func (e *EmailService) VerifyCode(userID, code string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	vc, ok := e.codes[userID]
	if !ok {
		return fmt.Errorf("no pending verification code")
	}

	if time.Now().After(vc.ExpiresAt) {
		delete(e.codes, userID)
		return fmt.Errorf("verification code expired")
	}

	vc.Attempts++
	if vc.Attempts > MaxVerificationAttempts {
		delete(e.codes, userID)
		return fmt.Errorf("too many attempts, code invalidated")
	}

	if vc.Code != code {
		return fmt.Errorf("invalid verification code")
	}

	// Success — remove the code.
	delete(e.codes, userID)
	return nil
}

// HasPendingCode returns true if a valid pending code exists for the user.
func (e *EmailService) HasPendingCode(userID string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()

	vc, ok := e.codes[userID]
	if !ok {
		return false
	}
	return time.Now().Before(vc.ExpiresAt)
}

// Cleanup removes expired codes.
func (e *EmailService) Cleanup() {
	e.mu.Lock()
	defer e.mu.Unlock()

	now := time.Now()
	for id, vc := range e.codes {
		if now.After(vc.ExpiresAt) {
			delete(e.codes, id)
		}
	}
}

// GenerateResetCode creates a password reset code for the given email.
func (e *EmailService) GenerateResetCode(email string) (string, error) {
	code, err := generateRandomCode(VerificationCodeLength)
	if err != nil {
		return "", fmt.Errorf("generating reset code: %w", err)
	}

	email = strings.ToLower(strings.TrimSpace(email))
	e.mu.Lock()
	e.resetCodes[email] = &VerificationCode{
		Code:      code,
		Email:     email,
		ExpiresAt: time.Now().Add(VerificationCodeTTL),
		Attempts:  0,
	}
	e.mu.Unlock()

	return code, nil
}

// SendPasswordResetEmail sends a password reset code email.
func (e *EmailService) SendPasswordResetEmail(toEmail, code string) error {
	if !e.IsConfigured() {
		return fmt.Errorf("SMTP not configured")
	}

	msg := buildPasswordResetEmail(e.from, toEmail, code)

	addr := fmt.Sprintf("%s:%d", e.host, e.port)
	tlsConfig := &tls.Config{ServerName: e.host}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	if err != nil {
		return fmt.Errorf("TLS dial %s: %w", addr, err)
	}

	client, err := smtp.NewClient(conn, e.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer func() { _ = client.Quit() }()

	auth := smtp.PlainAuth("", e.user, e.password, e.host)
	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP auth: %w", err)
	}

	if err := client.Mail(e.from); err != nil {
		return fmt.Errorf("SMTP MAIL FROM: %w", err)
	}
	if err := client.Rcpt(toEmail); err != nil {
		return fmt.Errorf("SMTP RCPT TO: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA: %w", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("writing email: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("closing email writer: %w", err)
	}

	return nil
}

// VerifyResetCode checks the password reset code for the given email.
func (e *EmailService) VerifyResetCode(email, code string) error {
	email = strings.ToLower(strings.TrimSpace(email))

	e.mu.Lock()
	defer e.mu.Unlock()

	vc, ok := e.resetCodes[email]
	if !ok {
		return fmt.Errorf("no pending reset code")
	}

	if time.Now().After(vc.ExpiresAt) {
		delete(e.resetCodes, email)
		return fmt.Errorf("reset code expired")
	}

	vc.Attempts++
	if vc.Attempts > MaxVerificationAttempts {
		delete(e.resetCodes, email)
		return fmt.Errorf("too many attempts, code invalidated")
	}

	if vc.Code != code {
		return fmt.Errorf("invalid reset code")
	}

	delete(e.resetCodes, email)
	return nil
}

// buildPasswordResetEmail constructs the MIME message for password reset.
func buildPasswordResetEmail(from, to, code string) string {
	ttlMinutes := int(VerificationCodeTTL.Minutes())
	subject := "ProgreSQL — Password Reset Code"

	plainBody := fmt.Sprintf(
		"Your ProgreSQL password reset code: %s\r\n\r\nThe code is valid for %d minutes.\r\nIf you did not request this, please ignore this email.",
		code, ttlMinutes,
	)

	htmlBody := buildPasswordResetHTML(code, ttlMinutes)

	var b strings.Builder
	_, _ = fmt.Fprintf(&b, "From: ProgreSQL <%s>\r\n", from)
	_, _ = fmt.Fprintf(&b, "To: %s\r\n", to)
	_, _ = fmt.Fprintf(&b, "Subject: =?UTF-8?B?%s?=\r\n", base64Encode(subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("X-Mailer: ProgreSQL/1.0\r\n")
	b.WriteString("X-Priority: 3\r\n")
	_, _ = fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n", mimeBoundary)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(plainBody)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s--\r\n", mimeBoundary)

	return b.String()
}

// buildPasswordResetHTML returns dark-themed HTML for password reset email.
func buildPasswordResetHTML(code string, ttlMinutes int) string {
	digits := make([]string, len(code))
	for i, ch := range code {
		digits[i] = fmt.Sprintf(
			`<td width="38" height="46" align="center" valign="middle" style="width:38px;height:46px;text-align:center;font-size:22px;font-weight:700;font-family:Consolas,'Courier New',monospace;color:#ffffff;background-color:#6366f1;border-radius:8px;">%c</td><td width="4" style="width:4px;"></td>`,
			ch,
		)
	}
	codeHTML := `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>` + strings.Join(digits, "") + `</tr></table>`

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ProgreSQL Password Reset</title>
</head>
<body style="margin:0;padding:0;background-color:#080b12;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080b12;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:#0f1423;border-radius:16px;overflow:hidden;border:1px solid #1b1f3a;">
<tr>
<td style="background-color:#0c1019;padding:28px 32px 24px;text-align:center;border-bottom:1px solid #1b1f3a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <img src="data:image/png;base64,`+logoBase64+`" alt="ProgreSQL" width="36" height="36" style="display:block;border-radius:8px;" />
      </td>
      <td style="vertical-align:middle;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">ProgreSQL</span>
      </td>
    </tr>
  </table>
</td>
</tr>
<tr>
<td style="padding:32px;">
  <p style="margin:0 0 6px;color:#ffffff;font-size:18px;font-weight:600;">Reset your password</p>
  <p style="margin:0 0 28px;color:#9ca3af;font-size:14px;line-height:1.5;">Enter the code below in the app to reset your password.</p>
  <div style="text-align:center;margin:0 0 28px;font-size:0;">
    %s
  </div>
  <p style="margin:0 0 4px;color:#9ca3af;font-size:13px;text-align:center;">This code expires in <strong style="color:#6366f1;">%d minutes</strong>.</p>
  <p style="margin:0;color:#6b7280;font-size:12px;text-align:center;">If you didn't request this, you can safely ignore this email.</p>
</td>
</tr>
<tr>
<td style="padding:20px 32px;background-color:#0a0e17;border-top:1px solid #1b1f3a;text-align:center;">
  <p style="margin:0;color:#6b7280;font-size:11px;line-height:1.4;">
    This is an automated message from ProgreSQL.<br>
    Please do not reply to this email.
  </p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`, codeHTML, ttlMinutes)
}

// SendTrialExpiryEmail sends a notification about trial/subscription expiration.
// daysLeft is the number of days remaining (0 means expired today).
func (e *EmailService) SendTrialExpiryEmail(toEmail string, daysLeft int) error {
	if !e.IsConfigured() {
		return fmt.Errorf("SMTP not configured")
	}

	msg := buildTrialExpiryEmail(e.from, toEmail, daysLeft)
	return e.sendRawEmail(toEmail, msg)
}

// sendRawEmail sends a pre-built MIME message via SMTP.
func (e *EmailService) sendRawEmail(toEmail, msg string) error {
	addr := fmt.Sprintf("%s:%d", e.host, e.port)
	tlsConfig := &tls.Config{ServerName: e.host}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, tlsConfig)
	if err != nil {
		return fmt.Errorf("TLS dial %s: %w", addr, err)
	}

	client, err := smtp.NewClient(conn, e.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer func() { _ = client.Quit() }()

	smtpAuth := smtp.PlainAuth("", e.user, e.password, e.host)
	if err := client.Auth(smtpAuth); err != nil {
		return fmt.Errorf("SMTP auth: %w", err)
	}

	if err := client.Mail(e.from); err != nil {
		return fmt.Errorf("SMTP MAIL FROM: %w", err)
	}
	if err := client.Rcpt(toEmail); err != nil {
		return fmt.Errorf("SMTP RCPT TO: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA: %w", err)
	}
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("writing email: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("closing email writer: %w", err)
	}

	return nil
}

// buildTrialExpiryEmail constructs a MIME message for trial/subscription expiry notification.
func buildTrialExpiryEmail(from, to string, daysLeft int) string {
	var subject, heading, message string
	accentColor := "#f59e0b" // amber for warning

	if daysLeft <= 0 {
		subject = "ProgreSQL — Your trial has expired"
		heading = "Your trial has expired"
		message = "Your free trial period has ended. Upgrade to Pro to continue using AI-powered SQL features."
		accentColor = "#ef4444" // red for expired
	} else if daysLeft == 1 {
		subject = "ProgreSQL — Your trial expires tomorrow"
		heading = "Your trial expires tomorrow"
		message = "Your free trial period ends tomorrow. Upgrade to Pro to keep using AI-powered SQL features without interruption."
	} else {
		subject = fmt.Sprintf("ProgreSQL — Your trial expires in %d days", daysLeft)
		heading = fmt.Sprintf("Your trial expires in %d days", daysLeft)
		message = fmt.Sprintf("Your free trial period ends in %d days. Upgrade to Pro to continue using AI-powered SQL features.", daysLeft)
	}

	plainBody := fmt.Sprintf("%s\r\n\r\n%s\r\n\r\nView plans at: https://progresql.com/#pricing", heading, message)

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>ProgreSQL</title></head>
<body style="margin:0;padding:0;background-color:#080b12;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080b12;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background-color:#0f1423;border-radius:16px;overflow:hidden;border:1px solid #1b1f3a;">
<tr>
<td style="background-color:#0c1019;padding:28px 32px 24px;text-align:center;border-bottom:1px solid #1b1f3a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <img src="data:image/png;base64,`+logoBase64+`" alt="ProgreSQL" width="36" height="36" style="display:block;border-radius:8px;" />
      </td>
      <td style="vertical-align:middle;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">ProgreSQL</span>
      </td>
    </tr>
  </table>
</td>
</tr>
<tr>
<td style="padding:32px;">
  <p style="margin:0 0 6px;color:%s;font-size:18px;font-weight:600;">%s</p>
  <p style="margin:0 0 28px;color:#9ca3af;font-size:14px;line-height:1.5;">%s</p>
  <div style="text-align:center;margin:0 0 28px;">
    <a href="https://progresql.com/#pricing" style="display:inline-block;padding:12px 32px;background-color:#6366f1;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">View Plans</a>
    <p style="margin:8px 0 0;color:#6b7280;font-size:12px;text-align:center;">To upgrade, open the app → Settings → Upgrade to Pro</p>
  </div>
</td>
</tr>
<tr>
<td style="padding:20px 32px;background-color:#0a0e17;border-top:1px solid #1b1f3a;text-align:center;">
  <p style="margin:0;color:#6b7280;font-size:11px;line-height:1.4;">
    This is an automated message from ProgreSQL.<br>
    Please do not reply to this email.
  </p>
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`, accentColor, heading, message)

	var b strings.Builder
	_, _ = fmt.Fprintf(&b, "From: ProgreSQL <%s>\r\n", from)
	_, _ = fmt.Fprintf(&b, "To: %s\r\n", to)
	_, _ = fmt.Fprintf(&b, "Subject: =?UTF-8?B?%s?=\r\n", base64Encode(subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("X-Mailer: ProgreSQL/1.0\r\n")
	b.WriteString("X-Priority: 3\r\n")
	_, _ = fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n", mimeBoundary)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(plainBody)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s\r\n", mimeBoundary)
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	b.WriteString("\r\n")

	_, _ = fmt.Fprintf(&b, "--%s--\r\n", mimeBoundary)

	return b.String()
}

func generateRandomCode(length int) (string, error) {
	digits := make([]byte, length)
	for i := range digits {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		digits[i] = byte('0' + n.Int64())
	}
	return string(digits), nil
}
