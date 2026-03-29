package notifications

import (
	"strings"
	"testing"
	"time"
)

// TestAllTemplatesNonEmpty verifies every template function returns a non-empty string.
func TestAllTemplatesNonEmpty(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	templates := map[string]string{
		"QuotaWarningEmail_ru":            QuotaWarningEmail("ru", "ai_tokens", 80, 5000),
		"QuotaWarningEmail_en":            QuotaWarningEmail("en", "ai_tokens", 80, 5000),
		"QuotaExhaustedEmail_ru":          QuotaExhaustedEmail("ru", "ai_tokens"),
		"QuotaExhaustedEmail_en":          QuotaExhaustedEmail("en", "ai_tokens"),
		"BalanceLowEmail_ru":              BalanceLowEmail("ru", 42.50),
		"BalanceLowEmail_en":              BalanceLowEmail("en", 42.50),
		"BalanceDepletedEmail_ru":         BalanceDepletedEmail("ru"),
		"BalanceDepletedEmail_en":         BalanceDepletedEmail("en"),
		"BalanceTopUpConfirmEmail_ru":     BalanceTopUpConfirmEmail("ru", 500, 542.50),
		"BalanceTopUpConfirmEmail_en":     BalanceTopUpConfirmEmail("en", 500, 542.50),
		"WelcomeEmail_ru":                 WelcomeEmail("ru", "Иван"),
		"WelcomeEmail_en":                 WelcomeEmail("en", "John"),
		"SubscriptionActivatedEmail_ru":   SubscriptionActivatedEmail("ru", "Pro", expiry),
		"SubscriptionActivatedEmail_en":   SubscriptionActivatedEmail("en", "Pro", expiry),
	}

	for name, html := range templates {
		if html == "" {
			t.Errorf("%s returned empty string", name)
		}
	}
}

// TestAllTemplatesContainBrand verifies every template contains the ProgreSQL brand name.
func TestAllTemplatesContainBrand(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	templates := map[string]string{
		"QuotaWarningEmail_ru":            QuotaWarningEmail("ru", "ai_tokens", 80, 5000),
		"QuotaWarningEmail_en":            QuotaWarningEmail("en", "ai_tokens", 80, 5000),
		"QuotaExhaustedEmail_ru":          QuotaExhaustedEmail("ru", "storage"),
		"QuotaExhaustedEmail_en":          QuotaExhaustedEmail("en", "storage"),
		"BalanceLowEmail_ru":              BalanceLowEmail("ru", 50),
		"BalanceLowEmail_en":              BalanceLowEmail("en", 50),
		"BalanceDepletedEmail_ru":         BalanceDepletedEmail("ru"),
		"BalanceDepletedEmail_en":         BalanceDepletedEmail("en"),
		"BalanceTopUpConfirmEmail_ru":     BalanceTopUpConfirmEmail("ru", 1000, 1050),
		"BalanceTopUpConfirmEmail_en":     BalanceTopUpConfirmEmail("en", 1000, 1050),
		"WelcomeEmail_ru":                 WelcomeEmail("ru", "Тест"),
		"WelcomeEmail_en":                 WelcomeEmail("en", "Test"),
		"SubscriptionActivatedEmail_ru":   SubscriptionActivatedEmail("ru", "Pro Plus", expiry),
		"SubscriptionActivatedEmail_en":   SubscriptionActivatedEmail("en", "Pro Plus", expiry),
	}

	for name, html := range templates {
		if !strings.Contains(html, "ProgreSQL") {
			t.Errorf("%s does not contain brand name 'ProgreSQL'", name)
		}
	}
}

// TestHTMLClosingTag ensures all templates produce valid HTML with a closing </html> tag.
func TestHTMLClosingTag(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	templates := map[string]string{
		"QuotaWarningEmail":          QuotaWarningEmail("ru", "ai_tokens", 80, 5000),
		"QuotaExhaustedEmail":        QuotaExhaustedEmail("en", "storage"),
		"BalanceLowEmail":            BalanceLowEmail("ru", 99),
		"BalanceDepletedEmail":       BalanceDepletedEmail("en"),
		"BalanceTopUpConfirmEmail":   BalanceTopUpConfirmEmail("ru", 200, 300),
		"WelcomeEmail":               WelcomeEmail("en", "User"),
		"SubscriptionActivatedEmail": SubscriptionActivatedEmail("ru", "Pro", expiry),
	}

	for name, html := range templates {
		if !strings.Contains(html, "</html>") {
			t.Errorf("%s missing closing </html> tag", name)
		}
		if !strings.Contains(html, "<!DOCTYPE html>") {
			t.Errorf("%s missing <!DOCTYPE html> declaration", name)
		}
	}
}

// TestRussianTemplatesContainRussianText verifies Russian templates have Cyrillic content.
func TestRussianTemplatesContainRussianText(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		html     string
		expected string
	}{
		{"QuotaWarningEmail_ru", QuotaWarningEmail("ru", "ai_tokens", 85, 3000), "квот"},
		{"QuotaExhaustedEmail_ru", QuotaExhaustedEmail("ru", "ai_tokens"), "исчерпана"},
		{"BalanceLowEmail_ru", BalanceLowEmail("ru", 50), "баланс"},
		{"BalanceDepletedEmail_ru", BalanceDepletedEmail("ru"), "пуст"},
		{"BalanceTopUpConfirmEmail_ru", BalanceTopUpConfirmEmail("ru", 500, 550), "пополнен"},
		{"WelcomeEmail_ru", WelcomeEmail("ru", "Тест"), "Добро пожаловать"},
		{"SubscriptionActivatedEmail_ru", SubscriptionActivatedEmail("ru", "Pro", expiry), "активирован"},
	}

	for _, tc := range cases {
		if !strings.Contains(strings.ToLower(tc.html), strings.ToLower(tc.expected)) {
			t.Errorf("%s does not contain expected Russian text %q", tc.name, tc.expected)
		}
	}
}

// TestEnglishTemplatesContainEnglishText verifies English templates have proper English content.
func TestEnglishTemplatesContainEnglishText(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		html     string
		expected string
	}{
		{"QuotaWarningEmail_en", QuotaWarningEmail("en", "ai_tokens", 85, 3000), "running low"},
		{"QuotaExhaustedEmail_en", QuotaExhaustedEmail("en", "storage"), "exhausted"},
		{"BalanceLowEmail_en", BalanceLowEmail("en", 50), "balance is low"},
		{"BalanceDepletedEmail_en", BalanceDepletedEmail("en"), "balance is empty"},
		{"BalanceTopUpConfirmEmail_en", BalanceTopUpConfirmEmail("en", 500, 550), "top-up successful"},
		{"WelcomeEmail_en", WelcomeEmail("en", "John"), "Welcome"},
		{"SubscriptionActivatedEmail_en", SubscriptionActivatedEmail("en", "Pro", expiry), "plan is active"},
	}

	for _, tc := range cases {
		if !strings.Contains(strings.ToLower(tc.html), strings.ToLower(tc.expected)) {
			t.Errorf("%s does not contain expected English text %q", tc.name, tc.expected)
		}
	}
}

// TestNoUnresolvedPlaceholders ensures templates are fully rendered with no Go template markers.
func TestNoUnresolvedPlaceholders(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	templates := map[string]string{
		"QuotaWarningEmail_ru":            QuotaWarningEmail("ru", "ai_tokens", 80, 5000),
		"QuotaWarningEmail_en":            QuotaWarningEmail("en", "ai_tokens", 80, 5000),
		"QuotaExhaustedEmail_ru":          QuotaExhaustedEmail("ru", "storage"),
		"QuotaExhaustedEmail_en":          QuotaExhaustedEmail("en", "storage"),
		"BalanceLowEmail_ru":              BalanceLowEmail("ru", 42.50),
		"BalanceLowEmail_en":              BalanceLowEmail("en", 42.50),
		"BalanceDepletedEmail_ru":         BalanceDepletedEmail("ru"),
		"BalanceDepletedEmail_en":         BalanceDepletedEmail("en"),
		"BalanceTopUpConfirmEmail_ru":     BalanceTopUpConfirmEmail("ru", 500, 542.50),
		"BalanceTopUpConfirmEmail_en":     BalanceTopUpConfirmEmail("en", 500, 542.50),
		"WelcomeEmail_ru":                 WelcomeEmail("ru", "Иван"),
		"WelcomeEmail_en":                 WelcomeEmail("en", "John"),
		"WelcomeEmail_empty":              WelcomeEmail("en", ""),
		"SubscriptionActivatedEmail_ru":   SubscriptionActivatedEmail("ru", "Pro", expiry),
		"SubscriptionActivatedEmail_en":   SubscriptionActivatedEmail("en", "Pro", expiry),
	}

	placeholders := []string{"{{.", "{{", "}}", "<no value>", "%!"}

	for name, html := range templates {
		for _, ph := range placeholders {
			if strings.Contains(html, ph) {
				t.Errorf("%s contains unresolved placeholder %q", name, ph)
			}
		}
	}
}

// TestWelcomeEmailEmptyName ensures fallback name is used when empty string is passed.
func TestWelcomeEmailEmptyName(t *testing.T) {
	ruHTML := WelcomeEmail("ru", "")
	if !strings.Contains(ruHTML, "пользователь") {
		t.Error("Russian welcome email with empty name should contain fallback 'пользователь'")
	}

	enHTML := WelcomeEmail("en", "")
	if !strings.Contains(enHTML, "there") {
		t.Error("English welcome email with empty name should contain fallback 'there'")
	}
}

// TestQuotaWarningContainsPercentage verifies the percentage and remaining values appear.
func TestQuotaWarningContainsPercentage(t *testing.T) {
	html := QuotaWarningEmail("en", "ai_tokens", 85, 1500)
	if !strings.Contains(html, "85%") {
		t.Error("QuotaWarningEmail should contain '85%'")
	}
	if !strings.Contains(html, "1500") {
		t.Error("QuotaWarningEmail should contain remaining value '1500'")
	}
}

// TestBalanceLowContainsAmount verifies the balance amount appears in the email.
func TestBalanceLowContainsAmount(t *testing.T) {
	html := BalanceLowEmail("en", 42.50)
	if !strings.Contains(html, "42.50") {
		t.Error("BalanceLowEmail should contain balance amount '42.50'")
	}
}

// TestTopUpContainsAmounts verifies both amount and new balance appear.
func TestTopUpContainsAmounts(t *testing.T) {
	html := BalanceTopUpConfirmEmail("en", 500, 742.50)
	if !strings.Contains(html, "500.00") {
		t.Error("BalanceTopUpConfirmEmail should contain top-up amount '500.00'")
	}
	if !strings.Contains(html, "742.50") {
		t.Error("BalanceTopUpConfirmEmail should contain new balance '742.50'")
	}
}

// TestSubscriptionContainsPlanName verifies the plan name appears in the email.
func TestSubscriptionContainsPlanName(t *testing.T) {
	expiry := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	html := SubscriptionActivatedEmail("en", "Pro Plus", expiry)
	if !strings.Contains(html, "Pro Plus") {
		t.Error("SubscriptionActivatedEmail should contain plan name 'Pro Plus'")
	}
	if !strings.Contains(html, "December 31, 2026") {
		t.Error("SubscriptionActivatedEmail should contain formatted expiry date")
	}
}

// TestBrandColorsPresent verifies that brand colors are used in templates.
func TestBrandColorsPresent(t *testing.T) {
	html := WelcomeEmail("en", "Test")
	if !strings.Contains(html, "#1a1a2e") {
		t.Error("Template should contain brand dark color #1a1a2e")
	}
	if !strings.Contains(html, "#4ecca3") {
		t.Error("Template should contain brand green color #4ecca3")
	}
}

// TestTemplatesHaveInlineCSS verifies that CSS is inlined (no <style> tags).
func TestTemplatesHaveInlineCSS(t *testing.T) {
	expiry := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)

	templates := map[string]string{
		"QuotaWarning":          QuotaWarningEmail("en", "ai_tokens", 80, 5000),
		"WelcomeEmail":          WelcomeEmail("en", "Test"),
		"SubscriptionActivated": SubscriptionActivatedEmail("en", "Pro", expiry),
	}

	for name, html := range templates {
		if strings.Contains(html, "<style") {
			t.Errorf("%s should use inline CSS, not <style> tags", name)
		}
		if !strings.Contains(html, "style=") {
			t.Errorf("%s should have inline style attributes", name)
		}
	}
}
