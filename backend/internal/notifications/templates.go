package notifications

import (
	"fmt"
	"time"
)

// ---------- base layout helpers ----------

const (
	brandDark  = "#1a1a2e"
	brandDeep  = "#16213e"
	brandGreen = "#4ecca3"
	textDark   = "#333333"
	textMuted  = "#666666"
	textLight  = "#999999"
	bgPage     = "#f4f4f8"
	bgCard     = "#ffffff"
	bgFooter   = "#f8f8fc"
)

// wrapHTML builds a full responsive HTML email with branded header, body content, and footer.
func wrapHTML(title, bodyHTML string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>%s</title>
</head>
<body style="margin:0;padding:0;background:%s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:%s;padding:24px 0;">
<tr><td align="center">
<!--[if mso]><table width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:%s;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<!-- Header -->
<tr><td style="background:linear-gradient(135deg,%s,%s);padding:28px 32px;">
<table cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;">
<span style="color:%s;font-size:26px;font-weight:700;letter-spacing:-0.5px;">ProgreSQL</span>
</td>
</tr></table>
</td></tr>
<!-- Body -->
<tr><td style="padding:32px 32px 24px 32px;">
%s
</td></tr>
<!-- Footer -->
<tr><td style="background:%s;padding:20px 32px;border-top:1px solid #eeeeee;">
<p style="color:%s;font-size:12px;margin:0;line-height:1.5;">ProgreSQL — AI-powered PostgreSQL client</p>
<p style="color:%s;font-size:11px;margin:6px 0 0 0;line-height:1.4;">This is an automated message. Please do not reply.</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
		title,
		bgPage, bgPage, bgCard,
		brandDark, brandDeep,
		brandGreen,
		bodyHTML,
		bgFooter,
		textLight, textLight,
	)
}

// ctaButton returns an HTML table-based button (works in Outlook).
func ctaButton(label, href string) string {
	return fmt.Sprintf(`<table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px 0;">
<tr><td style="background:%s;border-radius:8px;padding:14px 28px;">
<a href="%s" style="color:%s;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">%s</a>
</td></tr>
</table>`, brandGreen, href, brandDark, label)
}

// heading returns a styled h2 element.
func heading(text string) string {
	return fmt.Sprintf(`<h2 style="margin:0 0 16px 0;color:%s;font-size:22px;font-weight:600;line-height:1.3;">%s</h2>`, brandDark, text)
}

// paragraph returns a styled paragraph element.
func paragraph(text string) string {
	return fmt.Sprintf(`<p style="color:%s;font-size:15px;line-height:1.65;margin:0 0 14px 0;">%s</p>`, textDark, text)
}

// mutedParagraph returns a subtle secondary paragraph.
func mutedParagraph(text string) string {
	return fmt.Sprintf(`<p style="color:%s;font-size:13px;line-height:1.5;margin:0 0 10px 0;">%s</p>`, textMuted, text)
}

// highlightBox returns a colored info box.
func highlightBox(bgColor, borderColor, textContent string) string {
	return fmt.Sprintf(`<table cellpadding="0" cellspacing="0" border="0" width="100%%" style="margin:20px 0;">
<tr><td style="background:%s;border-left:4px solid %s;border-radius:6px;padding:16px 20px;">
%s
</td></tr>
</table>`, bgColor, borderColor, textContent)
}

// warningBox returns an orange-tinted warning box.
func warningBox(content string) string {
	return highlightBox("#fff8f0", "#ff9f43", content)
}

// dangerBox returns a red-tinted danger box.
func dangerBox(content string) string {
	return highlightBox("#fef2f2", "#ef4444", content)
}

// successBox returns a green-tinted success box.
func successBox(content string) string {
	return highlightBox("#f0fdf4", brandGreen, content)
}

// ---------- localized text helpers ----------

type texts struct {
	title   string
	heading string
	body    string
	cta     string
}

func quotaTypeLabel(lang, quotaType string) string {
	labels := map[string]map[string]string{
		"ru": {
			"ai_tokens":    "AI-токены",
			"storage":      "хранилище",
			"queries":      "запросы",
			"connections":  "подключения",
			"ai_requests":  "AI-запросы",
		},
		"en": {
			"ai_tokens":    "AI tokens",
			"storage":      "storage",
			"queries":      "queries",
			"connections":  "connections",
			"ai_requests":  "AI requests",
		},
	}
	if m, ok := labels[lang]; ok {
		if v, ok := m[quotaType]; ok {
			return v
		}
	}
	return quotaType
}

// ---------- public template functions ----------

// QuotaWarningEmail generates HTML for the quota warning email (80% threshold).
func QuotaWarningEmail(lang, quotaType string, usedPct int, remaining int64) string {
	label := quotaTypeLabel(lang, quotaType)

	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "ProgreSQL — Quota Warning",
			heading: "Your quota is running low",
			body: fmt.Sprintf(
				"You have used <strong>%d%%</strong> of your <strong>%s</strong> quota. "+
					"Remaining: <strong>%d</strong>.",
				usedPct, label, remaining,
			),
			cta: "Upgrade Plan",
		}
	default: // ru
		t = texts{
			title:   "ProgreSQL — Предупреждение о квоте",
			heading: "Ваша квота почти исчерпана",
			body: fmt.Sprintf(
				"Вы использовали <strong>%d%%</strong> квоты <strong>%s</strong>. "+
					"Осталось: <strong>%d</strong>.",
				usedPct, label, remaining,
			),
			cta: "Повысить тариф",
		}
	}

	body := heading(t.heading) +
		warningBox(paragraph(t.body)) +
		ctaButton(t.cta, "https://progresql.com/pricing")

	return wrapHTML(t.title, body)
}

// QuotaExhaustedEmail generates HTML for the quota exhausted email (100%).
func QuotaExhaustedEmail(lang, quotaType string) string {
	label := quotaTypeLabel(lang, quotaType)

	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "ProgreSQL — Quota Exhausted",
			heading: "Your quota has been exhausted",
			body: fmt.Sprintf(
				"Your <strong>%s</strong> quota has been fully used. "+
					"Functionality may be limited until the quota resets or you upgrade your plan.",
				label,
			),
			cta: "Upgrade Plan",
		}
	default:
		t = texts{
			title:   "ProgreSQL — Квота исчерпана",
			heading: "Ваша квота полностью исчерпана",
			body: fmt.Sprintf(
				"Квота <strong>%s</strong> полностью использована. "+
					"Функциональность может быть ограничена до сброса квоты или повышения тарифа.",
				label,
			),
			cta: "Повысить тариф",
		}
	}

	body := heading(t.heading) +
		dangerBox(paragraph(t.body)) +
		ctaButton(t.cta, "https://progresql.com/pricing")

	return wrapHTML(t.title, body)
}

// BalanceLowEmail generates HTML for the low balance email (< 100 RUB).
func BalanceLowEmail(lang string, balance float64) string {
	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "ProgreSQL — Low Balance",
			heading: "Your balance is low",
			body: fmt.Sprintf(
				"Your current balance is <strong>%.2f RUB</strong>. "+
					"Top up your balance to continue using AI features without interruption.",
				balance,
			),
			cta: "Top Up Balance",
		}
	default:
		t = texts{
			title:   "ProgreSQL — Низкий баланс",
			heading: "У вас низкий баланс",
			body: fmt.Sprintf(
				"Ваш текущий баланс: <strong>%.2f руб.</strong> "+
					"Пополните баланс, чтобы продолжить использование AI-функций без перерывов.",
				balance,
			),
			cta: "Пополнить баланс",
		}
	}

	body := heading(t.heading) +
		warningBox(paragraph(t.body)) +
		ctaButton(t.cta, "https://progresql.com/balance")

	return wrapHTML(t.title, body)
}

// BalanceDepletedEmail generates HTML for the depleted balance email (= 0).
func BalanceDepletedEmail(lang string) string {
	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "ProgreSQL — Balance Depleted",
			heading: "Your balance is empty",
			body: "Your account balance has reached <strong>0 RUB</strong>. " +
				"AI-powered features are now unavailable. Top up your balance to restore access.",
			cta: "Top Up Balance",
		}
	default:
		t = texts{
			title:   "ProgreSQL — Баланс исчерпан",
			heading: "Ваш баланс пуст",
			body: "Баланс вашего аккаунта достиг <strong>0 руб.</strong> " +
				"AI-функции недоступны. Пополните баланс для восстановления доступа.",
			cta: "Пополнить баланс",
		}
	}

	body := heading(t.heading) +
		dangerBox(paragraph(t.body)) +
		ctaButton(t.cta, "https://progresql.com/balance")

	return wrapHTML(t.title, body)
}

// BalanceTopUpConfirmEmail generates HTML for the balance top-up confirmation.
func BalanceTopUpConfirmEmail(lang string, amount, newBalance float64) string {
	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "ProgreSQL — Balance Top-Up Confirmed",
			heading: "Balance top-up successful",
			body: fmt.Sprintf(
				"Your account has been credited with <strong>%.2f RUB</strong>. "+
					"New balance: <strong>%.2f RUB</strong>.",
				amount, newBalance,
			),
			cta: "Open ProgreSQL",
		}
	default:
		t = texts{
			title:   "ProgreSQL — Баланс пополнен",
			heading: "Баланс успешно пополнен",
			body: fmt.Sprintf(
				"На ваш аккаунт зачислено <strong>%.2f руб.</strong> "+
					"Новый баланс: <strong>%.2f руб.</strong>",
				amount, newBalance,
			),
			cta: "Открыть ProgreSQL",
		}
	}

	body := heading(t.heading) +
		successBox(paragraph(t.body)) +
		mutedParagraph(map[string]string{
			"en": "Thank you for your payment!",
		}[lang]) +
		ctaButton(t.cta, "https://progresql.com")
	if lang != "en" {
		body = heading(t.heading) +
			successBox(paragraph(t.body)) +
			mutedParagraph("Спасибо за оплату!") +
			ctaButton(t.cta, "https://progresql.com")
	}

	return wrapHTML(t.title, body)
}

// WelcomeEmail generates HTML for the welcome email after registration.
func WelcomeEmail(lang, userName string) string {
	displayName := userName
	if displayName == "" {
		switch lang {
		case "en":
			displayName = "there"
		default:
			displayName = "пользователь"
		}
	}

	var t texts
	switch lang {
	case "en":
		t = texts{
			title:   "Welcome to ProgreSQL!",
			heading: fmt.Sprintf("Welcome, %s!", displayName),
			cta:     "Get Started",
		}
	default:
		t = texts{
			title:   "Добро пожаловать в ProgreSQL!",
			heading: fmt.Sprintf("Добро пожаловать, %s!", displayName),
			cta:     "Начать работу",
		}
	}

	var features string
	switch lang {
	case "en":
		features = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">` +
			featureRow(brandGreen, "AI-powered SQL assistant that understands your schema") +
			featureRow(brandGreen, "Smart query optimization and error analysis") +
			featureRow(brandGreen, "Secure connection management for your databases") +
			featureRow(brandGreen, "Export, visualization, and much more") +
			`</table>`
	default:
		features = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">` +
			featureRow(brandGreen, "AI-ассистент для SQL, который понимает вашу схему") +
			featureRow(brandGreen, "Умная оптимизация запросов и анализ ошибок") +
			featureRow(brandGreen, "Безопасное управление подключениями к базам данных") +
			featureRow(brandGreen, "Экспорт, визуализация и многое другое") +
			`</table>`
	}

	var bodyText string
	switch lang {
	case "en":
		bodyText = "Your account has been created. Here is what ProgreSQL can do for you:"
	default:
		bodyText = "Ваш аккаунт успешно создан. Вот что ProgreSQL может для вас сделать:"
	}

	body := heading(t.heading) +
		paragraph(bodyText) +
		features +
		ctaButton(t.cta, "https://progresql.com")

	return wrapHTML(t.title, body)
}

// featureRow returns a single feature list item as a table row with a colored bullet.
func featureRow(bulletColor, text string) string {
	return fmt.Sprintf(`<tr><td style="padding:6px 0;">
<table cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:top;padding-right:12px;">
<span style="color:%s;font-size:18px;line-height:1;">&#8226;</span>
</td>
<td style="color:%s;font-size:14px;line-height:1.5;">%s</td>
</tr></table>
</td></tr>`, bulletColor, textDark, text)
}

// SubscriptionActivatedEmail generates HTML for plan activation confirmation.
func SubscriptionActivatedEmail(lang, planName string, expiresAt time.Time) string {
	expiryStr := expiresAt.Format("02.01.2006")

	var t texts
	switch lang {
	case "en":
		expiryStr = expiresAt.Format("January 2, 2006")
		t = texts{
			title:   "ProgreSQL — Subscription Activated",
			heading: fmt.Sprintf("Your %s plan is active!", planName),
			body: fmt.Sprintf(
				"Your <strong>%s</strong> subscription has been activated. "+
					"It is valid until <strong>%s</strong>. "+
					"Enjoy all premium features!",
				planName, expiryStr,
			),
			cta: "Open ProgreSQL",
		}
	default:
		t = texts{
			title:   "ProgreSQL — Подписка активирована",
			heading: fmt.Sprintf("Тариф %s активирован!", planName),
			body: fmt.Sprintf(
				"Ваша подписка <strong>%s</strong> активирована. "+
					"Действует до <strong>%s</strong>. "+
					"Пользуйтесь всеми премиум-функциями!",
				planName, expiryStr,
			),
			cta: "Открыть ProgreSQL",
		}
	}

	body := heading(t.heading) +
		successBox(paragraph(t.body)) +
		ctaButton(t.cta, "https://progresql.com")

	return wrapHTML(t.title, body)
}
