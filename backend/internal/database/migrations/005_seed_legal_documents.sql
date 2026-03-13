-- 005_seed_legal_documents.sql
-- Seed initial legal documents (version 1.0) in Russian and English.
-- Documents: privacy, terms, offer, crypto-payments, refunds.

-- ============================================================
-- 1. PRIVACY POLICY — Russian
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'privacy', '1.0',
  'Политика обработки персональных данных',
  'ru',
  '<h1>Политика обработки персональных данных</h1>
<p><strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 20 марта 2026 г.<br><strong>Последнее обновление:</strong> 20 марта 2026 г.</p>

<h2>1. Оператор</h2>
<p>Оператором персональных данных является администрация сервиса ProgreSQL (далее — «Оператор», «мы»).<br>
Электронная почта для связи: <a href="mailto:support@progresql.com">support@progresql.com</a></p>

<h2>2. Перечень обрабатываемых персональных данных</h2>
<p>Мы обрабатываем следующие категории персональных данных:</p>
<ul>
  <li>Адрес электронной почты (email) — для регистрации, аутентификации, уведомлений;</li>
  <li>Хеш пароля — для аутентификации (пароль в открытом виде не хранится);</li>
  <li>IP-адрес — для обеспечения безопасности и ведения журналов;</li>
  <li>User-Agent браузера/приложения — для технической поддержки и аналитики;</li>
  <li>Идентификатор платежа — для обработки оплаты через CryptoCloud;</li>
  <li>Дата и время действий пользователя — журналы событий.</li>
</ul>

<h2>3. Цели обработки</h2>
<ul>
  <li>Предоставление доступа к сервису ProgreSQL и его функциям;</li>
  <li>Аутентификация и авторизация пользователей;</li>
  <li>Обработка платежей и управление подписками;</li>
  <li>Отправка уведомлений о статусе подписки и безопасности аккаунта;</li>
  <li>Техническая поддержка и устранение неполадок;</li>
  <li>Обеспечение безопасности сервиса и предотвращение злоупотреблений;</li>
  <li>Выполнение требований законодательства.</li>
</ul>

<h2>4. Правовые основания обработки</h2>
<ul>
  <li><strong>Исполнение договора</strong> (ст. 6 п. 1 пп. b GDPR / п. 5 ч. 1 ст. 6 ФЗ-152) — обработка необходима для предоставления сервиса;</li>
  <li><strong>Согласие пользователя</strong> (ст. 6 п. 1 пп. a GDPR / п. 1 ч. 1 ст. 6 ФЗ-152) — при регистрации пользователь даёт согласие на обработку;</li>
  <li><strong>Законный интерес</strong> (ст. 6 п. 1 пп. f GDPR) — обеспечение безопасности сервиса.</li>
</ul>

<h2>5. Сроки хранения</h2>
<ul>
  <li>Данные аккаунта — в течение срока действия аккаунта и 30 дней после удаления;</li>
  <li>Платёжные данные — 3 года с момента совершения транзакции (требования бухгалтерского учёта);</li>
  <li>Журналы событий — 12 месяцев;</li>
  <li>Данные об акцепте правовых документов — бессрочно (для подтверждения согласия).</li>
</ul>

<h2>6. Передача данных третьим лицам</h2>
<p>Мы передаём данные следующим третьим лицам:</p>
<ul>
  <li><strong>CryptoCloud</strong> (платёжный провайдер) — email и идентификатор заказа для обработки криптовалютных платежей. Политика конфиденциальности CryptoCloud доступна на их сайте.</li>
</ul>
<p>Мы не продаём персональные данные и не передаём их иным третьим лицам, за исключением случаев, предусмотренных законодательством.</p>

<h2>7. Права пользователя</h2>
<p>Вы имеете право:</p>
<ul>
  <li>Запросить доступ к своим персональным данным;</li>
  <li>Запросить исправление неточных данных;</li>
  <li>Запросить удаление данных (право на забвение);</li>
  <li>Отозвать согласие на обработку данных;</li>
  <li>Запросить перенос данных (портативность);</li>
  <li>Подать жалобу в надзорный орган.</li>
</ul>

<h2>8. Порядок отзыва согласия</h2>
<p>Для отзыва согласия на обработку персональных данных направьте запрос на <a href="mailto:support@progresql.com">support@progresql.com</a> с указанием email вашего аккаунта. Обработка запроса — до 30 рабочих дней. Отзыв согласия влечёт удаление аккаунта и всех связанных данных.</p>

<h2>9. Безопасность</h2>
<p>Мы применяем следующие меры защиты: шифрование паролей (bcrypt), передача данных по HTTPS/TLS, JWT-токены для аутентификации, ограничение доступа к серверам.</p>

<h2>10. Контакты</h2>
<p>По вопросам обработки персональных данных: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 1. PRIVACY POLICY — English
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'privacy', '1.0',
  'Privacy Policy',
  'en',
  '<h1>Privacy Policy</h1>
<p><strong>Version:</strong> 1.0<br><strong>Effective date:</strong> March 20, 2026<br><strong>Last updated:</strong> March 20, 2026</p>

<h2>1. Data Controller</h2>
<p>The data controller is the ProgreSQL service administration (hereinafter "Controller", "we").<br>
Contact email: <a href="mailto:support@progresql.com">support@progresql.com</a></p>

<h2>2. Personal Data We Collect</h2>
<p>We process the following categories of personal data:</p>
<ul>
  <li>Email address — for registration, authentication, and notifications;</li>
  <li>Password hash — for authentication (plaintext passwords are never stored);</li>
  <li>IP address — for security and logging;</li>
  <li>Browser/application User-Agent — for technical support and analytics;</li>
  <li>Payment identifier — for processing payments via CryptoCloud;</li>
  <li>Timestamps of user actions — event logs.</li>
</ul>

<h2>3. Purposes of Processing</h2>
<ul>
  <li>Providing access to the ProgreSQL service and its features;</li>
  <li>User authentication and authorization;</li>
  <li>Payment processing and subscription management;</li>
  <li>Sending notifications about subscription status and account security;</li>
  <li>Technical support and troubleshooting;</li>
  <li>Ensuring service security and preventing abuse;</li>
  <li>Compliance with legal obligations.</li>
</ul>

<h2>4. Legal Basis for Processing</h2>
<ul>
  <li><strong>Performance of a contract</strong> (Art. 6(1)(b) GDPR) — processing is necessary to provide the service;</li>
  <li><strong>Consent</strong> (Art. 6(1)(a) GDPR) — the user gives consent upon registration;</li>
  <li><strong>Legitimate interest</strong> (Art. 6(1)(f) GDPR) — ensuring service security.</li>
</ul>

<h2>5. Data Retention</h2>
<ul>
  <li>Account data — for the duration of the account and 30 days after deletion;</li>
  <li>Payment data — 3 years from the transaction date (accounting requirements);</li>
  <li>Event logs — 12 months;</li>
  <li>Legal document acceptance records — indefinitely (to confirm consent).</li>
</ul>

<h2>6. Third-Party Data Sharing</h2>
<p>We share data with the following third parties:</p>
<ul>
  <li><strong>CryptoCloud</strong> (payment provider) — email and order identifier for processing cryptocurrency payments. CryptoCloud''s privacy policy is available on their website.</li>
</ul>
<p>We do not sell personal data or share it with other third parties except as required by law.</p>

<h2>7. Your Rights</h2>
<p>You have the right to:</p>
<ul>
  <li>Request access to your personal data;</li>
  <li>Request correction of inaccurate data;</li>
  <li>Request deletion of data (right to erasure);</li>
  <li>Withdraw consent to data processing;</li>
  <li>Request data portability;</li>
  <li>Lodge a complaint with a supervisory authority.</li>
</ul>

<h2>8. Withdrawal of Consent</h2>
<p>To withdraw consent for data processing, send a request to <a href="mailto:support@progresql.com">support@progresql.com</a> specifying your account email. Processing time — up to 30 business days. Withdrawal of consent results in account deletion and removal of all associated data.</p>

<h2>9. Security</h2>
<p>We implement the following security measures: password encryption (bcrypt), data transmission over HTTPS/TLS, JWT tokens for authentication, restricted server access.</p>

<h2>10. Contact</h2>
<p>For data processing inquiries: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 2. TERMS OF USE — Russian
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'terms', '1.0',
  'Пользовательское соглашение',
  'ru',
  '<h1>Пользовательское соглашение</h1>
<p><strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 20 марта 2026 г.<br><strong>Последнее обновление:</strong> 20 марта 2026 г.</p>

<h2>1. Общие положения</h2>
<p>Настоящее Пользовательское соглашение (далее — «Соглашение») регулирует отношения между администрацией сервиса ProgreSQL (далее — «Администрация») и пользователем (далее — «Пользователь») при использовании десктопного приложения ProgreSQL и связанных онлайн-сервисов.</p>
<p>ProgreSQL — это клиентское приложение для работы с базами данных PostgreSQL с интегрированным AI-ассистентом.</p>

<h2>2. Регистрация и аккаунт</h2>
<ul>
  <li>Для использования AI-функций и управления подпиской необходима регистрация;</li>
  <li>Пользователь обязуется предоставить достоверный адрес электронной почты;</li>
  <li>Пользователь несёт ответственность за сохранность своих учётных данных;</li>
  <li>Один аккаунт предназначен для одного пользователя.</li>
</ul>

<h2>3. Ответственность пользователя за SQL-запросы</h2>
<p><strong>Пользователь несёт полную ответственность за все SQL-запросы, выполняемые через ProgreSQL к своим базам данных.</strong></p>
<ul>
  <li>ProgreSQL предоставляет интерфейс для подключения к базам данных, которыми управляет Пользователь;</li>
  <li>Все операции INSERT, UPDATE, DELETE, DROP и иные модифицирующие запросы выполняются под ответственность Пользователя;</li>
  <li>Администрация не несёт ответственности за потерю данных, повреждение таблиц или иные последствия выполнения SQL-запросов;</li>
  <li>Рекомендуется использовать режим Safe Mode для предотвращения случайного выполнения опасных запросов.</li>
</ul>

<h2>4. AI-ассистент: ограничения и отказ от гарантий</h2>
<p><strong>AI-ассистент предоставляется «как есть» (as is) и не является гарантией корректности.</strong></p>
<ul>
  <li>AI может генерировать некорректный, неоптимальный или опасный SQL-код;</li>
  <li>Пользователь обязан проверять все SQL-запросы, сгенерированные AI, перед их выполнением;</li>
  <li>Администрация не несёт ответственности за результаты выполнения SQL-запросов, предложенных AI;</li>
  <li>AI-ответы не являются профессиональной консультацией по администрированию баз данных.</li>
</ul>

<h2>5. Запрет неавторизованного доступа</h2>
<p>Пользователь обязуется:</p>
<ul>
  <li>Подключаться только к базам данных, к которым имеет законный доступ;</li>
  <li>Не использовать ProgreSQL для неавторизованного доступа к чужим базам данных;</li>
  <li>Не использовать сервис для нарушения законодательства или прав третьих лиц;</li>
  <li>Не предпринимать попыток обхода систем безопасности сервиса.</li>
</ul>

<h2>6. Подписка и тарифы</h2>
<ul>
  <li>Базовые функции (SQL-редактор, браузер БД) доступны бесплатно;</li>
  <li>AI-функции (чат, улучшение запросов) доступны по подписке Pro;</li>
  <li>Стоимость и условия подписки указаны в Публичной оферте;</li>
  <li>Пробный период (trial) предоставляется при регистрации.</li>
</ul>

<h2>7. Ограничение ответственности</h2>
<p>Администрация не несёт ответственности за:</p>
<ul>
  <li>Убытки, связанные с потерей данных в базах данных Пользователя;</li>
  <li>Перебои в работе сервиса, вызванные техническими причинами;</li>
  <li>Действия третьих лиц, получивших доступ к аккаунту Пользователя;</li>
  <li>Результаты использования рекомендаций AI-ассистента.</li>
</ul>

<h2>8. Изменение условий</h2>
<p>Администрация вправе изменять настоящее Соглашение. Уведомление об изменениях направляется на email Пользователя не менее чем за 14 дней до вступления в силу новой версии.</p>

<h2>9. Контакты</h2>
<p>Служба поддержки: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 2. TERMS OF USE — English
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'terms', '1.0',
  'Terms of Use',
  'en',
  '<h1>Terms of Use</h1>
<p><strong>Version:</strong> 1.0<br><strong>Effective date:</strong> March 20, 2026<br><strong>Last updated:</strong> March 20, 2026</p>

<h2>1. General Provisions</h2>
<p>These Terms of Use (hereinafter "Terms") govern the relationship between the ProgreSQL service administration (hereinafter "Administration") and the user (hereinafter "User") when using the ProgreSQL desktop application and related online services.</p>
<p>ProgreSQL is a desktop client application for working with PostgreSQL databases with an integrated AI assistant.</p>

<h2>2. Registration and Account</h2>
<ul>
  <li>Registration is required for AI features and subscription management;</li>
  <li>The User agrees to provide a valid email address;</li>
  <li>The User is responsible for maintaining the security of their credentials;</li>
  <li>One account is intended for one user.</li>
</ul>

<h2>3. User Responsibility for SQL Queries</h2>
<p><strong>The User bears full responsibility for all SQL queries executed through ProgreSQL against their databases.</strong></p>
<ul>
  <li>ProgreSQL provides an interface for connecting to databases managed by the User;</li>
  <li>All INSERT, UPDATE, DELETE, DROP, and other modifying queries are executed under the User''s responsibility;</li>
  <li>The Administration is not liable for data loss, table corruption, or other consequences of SQL query execution;</li>
  <li>It is recommended to use Safe Mode to prevent accidental execution of dangerous queries.</li>
</ul>

<h2>4. AI Assistant: Limitations and Disclaimer</h2>
<p><strong>The AI assistant is provided "as is" and does not guarantee correctness.</strong></p>
<ul>
  <li>AI may generate incorrect, suboptimal, or dangerous SQL code;</li>
  <li>The User must review all AI-generated SQL queries before execution;</li>
  <li>The Administration is not liable for the results of executing AI-suggested SQL queries;</li>
  <li>AI responses do not constitute professional database administration advice.</li>
</ul>

<h2>5. Prohibition of Unauthorized Access</h2>
<p>The User agrees to:</p>
<ul>
  <li>Connect only to databases to which they have lawful access;</li>
  <li>Not use ProgreSQL for unauthorized access to third-party databases;</li>
  <li>Not use the service to violate laws or third-party rights;</li>
  <li>Not attempt to circumvent the service''s security systems.</li>
</ul>

<h2>6. Subscription and Plans</h2>
<ul>
  <li>Basic features (SQL editor, database browser) are available for free;</li>
  <li>AI features (chat, query improvement) require a Pro subscription;</li>
  <li>Pricing and subscription terms are specified in the Public Offer;</li>
  <li>A trial period is provided upon registration.</li>
</ul>

<h2>7. Limitation of Liability</h2>
<p>The Administration is not liable for:</p>
<ul>
  <li>Losses related to data loss in the User''s databases;</li>
  <li>Service interruptions caused by technical issues;</li>
  <li>Actions of third parties who gain access to the User''s account;</li>
  <li>Results of using AI assistant recommendations.</li>
</ul>

<h2>8. Changes to Terms</h2>
<p>The Administration reserves the right to modify these Terms. Notification of changes will be sent to the User''s email at least 14 days before the new version takes effect.</p>

<h2>9. Contact</h2>
<p>Support: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 3. PUBLIC OFFER — Russian
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'offer', '1.0',
  'Публичная оферта',
  'ru',
  '<h1>Публичная оферта</h1>
<p><strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 20 марта 2026 г.<br><strong>Последнее обновление:</strong> 20 марта 2026 г.</p>

<h2>1. Предмет оферты</h2>
<p>Настоящая публичная оферта (далее — «Оферта») является официальным предложением администрации сервиса ProgreSQL (далее — «Исполнитель») заключить договор на предоставление доступа к SaaS-сервису ProgreSQL на условиях, изложенных ниже.</p>
<p>ProgreSQL — десктопное приложение для работы с базами данных PostgreSQL с интегрированным AI-ассистентом, предоставляемое по модели подписки.</p>

<h2>2. Момент акцепта</h2>
<p>Акцептом (принятием) Оферты является:</p>
<ul>
  <li>Проставление отметки (чекбокс) о согласии с Офертой при оформлении подписки; или</li>
  <li>Совершение оплаты подписки.</li>
</ul>
<p>С момента акцепта Оферта приобретает силу договора.</p>

<h2>3. Тарифы</h2>
<table>
  <tr><th>Тариф</th><th>Стоимость</th><th>Период</th><th>Функции</th></tr>
  <tr><td>Free</td><td>Бесплатно</td><td>Бессрочно</td><td>SQL-редактор, браузер БД, экспорт</td></tr>
  <tr><td>Pro</td><td>5 USD</td><td>30 дней</td><td>Все функции Free + AI-чат, улучшение запросов, анализ схемы</td></tr>
</table>
<p>Исполнитель вправе изменять тарифы с уведомлением за 14 дней. Изменение не затрагивает оплаченный период.</p>

<h2>4. Условия оплаты</h2>
<ul>
  <li>Оплата производится через платёжный сервис CryptoCloud в криптовалюте;</li>
  <li>Поддерживаемые валюты определяются CryptoCloud на момент оплаты;</li>
  <li>Подписка активируется после подтверждения платежа сетью блокчейн и получения webhook от CryptoCloud;</li>
  <li>Переход на страницу успешной оплаты (redirect) не является подтверждением — активация происходит только по серверному подтверждению;</li>
  <li>Срок подписки: 30 дней с момента подтверждения оплаты.</li>
</ul>

<h2>5. Возвраты</h2>
<p>Условия возврата средств описаны в документе «Политика возвратов».</p>

<h2>6. Ограничение ответственности</h2>
<ul>
  <li>Исполнитель предоставляет сервис «как есть» (as is);</li>
  <li>Максимальная ответственность Исполнителя ограничена суммой оплаты за текущий период подписки;</li>
  <li>Исполнитель не несёт ответственности за косвенные убытки, упущенную выгоду, потерю данных в базах данных Пользователя;</li>
  <li>Исполнитель не гарантирует бесперебойную работу сервиса.</li>
</ul>

<h2>7. Срок действия и расторжение</h2>
<ul>
  <li>Договор действует в течение оплаченного периода подписки;</li>
  <li>По истечении подписки аккаунт переходит на тариф Free;</li>
  <li>Пользователь может отказаться от продления, не совершая повторную оплату;</li>
  <li>Исполнитель вправе заблокировать аккаунт при нарушении Пользовательского соглашения.</li>
</ul>

<h2>8. Контакты</h2>
<p>Служба поддержки: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 3. PUBLIC OFFER — English
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'offer', '1.0',
  'Public Offer Agreement',
  'en',
  '<h1>Public Offer Agreement</h1>
<p><strong>Version:</strong> 1.0<br><strong>Effective date:</strong> March 20, 2026<br><strong>Last updated:</strong> March 20, 2026</p>

<h2>1. Subject of the Offer</h2>
<p>This public offer (hereinafter "Offer") is an official proposal by the ProgreSQL service administration (hereinafter "Provider") to enter into an agreement for access to the ProgreSQL SaaS service on the terms set forth below.</p>
<p>ProgreSQL is a desktop application for working with PostgreSQL databases with an integrated AI assistant, provided on a subscription basis.</p>

<h2>2. Acceptance</h2>
<p>Acceptance of the Offer occurs when:</p>
<ul>
  <li>The user checks the consent checkbox when subscribing; or</li>
  <li>Payment for the subscription is made.</li>
</ul>
<p>Upon acceptance, the Offer becomes a binding agreement.</p>

<h2>3. Pricing</h2>
<table>
  <tr><th>Plan</th><th>Price</th><th>Period</th><th>Features</th></tr>
  <tr><td>Free</td><td>Free</td><td>Unlimited</td><td>SQL editor, DB browser, export</td></tr>
  <tr><td>Pro</td><td>5 USD</td><td>30 days</td><td>All Free features + AI chat, query improvement, schema analysis</td></tr>
</table>
<p>The Provider reserves the right to change pricing with 14 days notice. Changes do not affect the currently paid period.</p>

<h2>4. Payment Terms</h2>
<ul>
  <li>Payment is processed via CryptoCloud in cryptocurrency;</li>
  <li>Supported currencies are determined by CryptoCloud at the time of payment;</li>
  <li>Subscription activates after blockchain network confirmation and CryptoCloud webhook receipt;</li>
  <li>Redirect to the success page does not constitute confirmation — activation occurs only upon server-side confirmation;</li>
  <li>Subscription period: 30 days from payment confirmation.</li>
</ul>

<h2>5. Refunds</h2>
<p>Refund conditions are described in the Refund Policy document.</p>

<h2>6. Limitation of Liability</h2>
<ul>
  <li>The service is provided "as is";</li>
  <li>The Provider''s maximum liability is limited to the payment amount for the current subscription period;</li>
  <li>The Provider is not liable for indirect damages, lost profits, or data loss in User databases;</li>
  <li>The Provider does not guarantee uninterrupted service operation.</li>
</ul>

<h2>7. Duration and Termination</h2>
<ul>
  <li>The agreement is valid for the paid subscription period;</li>
  <li>Upon subscription expiry, the account reverts to the Free plan;</li>
  <li>The User may decline renewal by not making another payment;</li>
  <li>The Provider may block the account for Terms of Use violations.</li>
</ul>

<h2>8. Contact</h2>
<p>Support: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 4. CRYPTO PAYMENT TERMS — Russian
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'crypto-payments', '1.0',
  'Условия криптовалютных платежей',
  'ru',
  '<h1>Условия криптовалютных платежей</h1>
<p><strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 20 марта 2026 г.<br><strong>Последнее обновление:</strong> 20 марта 2026 г.</p>

<h2>1. Общие положения</h2>
<p>Настоящие Условия регулируют порядок оплаты подписки на сервис ProgreSQL с использованием криптовалюты через платёжный провайдер CryptoCloud.</p>

<h2>2. Необратимость транзакций</h2>
<p><strong>Криптовалютные транзакции являются необратимыми.</strong></p>
<ul>
  <li>После отправки средств на адрес, указанный CryptoCloud, транзакция не может быть отменена;</li>
  <li>Пользователь обязан тщательно проверить адрес кошелька и выбранную сеть перед отправкой;</li>
  <li>Администрация ProgreSQL не имеет технической возможности вернуть средства, отправленные в блокчейн-сеть.</li>
</ul>

<h2>3. Поддерживаемые сети и валюты</h2>
<ul>
  <li>Перечень поддерживаемых криптовалют и сетей определяется CryptoCloud;</li>
  <li>Актуальный список доступен на странице оплаты;</li>
  <li>Администрация ProgreSQL не контролирует и не ограничивает список поддерживаемых сетей.</li>
</ul>

<h2>4. Комиссии</h2>
<ul>
  <li>Комиссия блокчейн-сети (gas fee) оплачивается Пользователем;</li>
  <li>Комиссия платёжного провайдера CryptoCloud включена в стоимость или указана отдельно на странице оплаты;</li>
  <li>Администрация ProgreSQL не взимает дополнительных комиссий.</li>
</ul>

<h2>5. Ответственность за выбор сети</h2>
<p><strong>Пользователь несёт полную ответственность за правильный выбор сети при отправке средств.</strong></p>
<ul>
  <li>Отправка средств в неподдерживаемую сеть или на неверный адрес может привести к безвозвратной потере средств;</li>
  <li>Администрация ProgreSQL не несёт ответственности за средства, потерянные из-за ошибочного выбора сети или адреса;</li>
  <li>Рекомендуется отправлять тестовую транзакцию перед крупным переводом.</li>
</ul>

<h2>6. Подтверждение платежа</h2>
<ul>
  <li>Платёж считается подтверждённым после получения необходимого количества подтверждений в блокчейн-сети;</li>
  <li>Количество подтверждений определяется CryptoCloud для каждой сети;</li>
  <li>Время подтверждения зависит от загруженности сети и может составлять от нескольких минут до нескольких часов;</li>
  <li>Подписка активируется автоматически после серверного подтверждения платежа (webhook от CryptoCloud).</li>
</ul>

<h2>7. Контакты</h2>
<p>По вопросам платежей: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 4. CRYPTO PAYMENT TERMS — English
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'crypto-payments', '1.0',
  'Cryptocurrency Payment Terms',
  'en',
  '<h1>Cryptocurrency Payment Terms</h1>
<p><strong>Version:</strong> 1.0<br><strong>Effective date:</strong> March 20, 2026<br><strong>Last updated:</strong> March 20, 2026</p>

<h2>1. General Provisions</h2>
<p>These Terms govern the payment process for ProgreSQL subscription using cryptocurrency via the CryptoCloud payment provider.</p>

<h2>2. Irreversibility of Transactions</h2>
<p><strong>Cryptocurrency transactions are irreversible.</strong></p>
<ul>
  <li>Once funds are sent to the address provided by CryptoCloud, the transaction cannot be reversed;</li>
  <li>The User must carefully verify the wallet address and selected network before sending;</li>
  <li>ProgreSQL administration has no technical ability to recover funds sent to a blockchain network.</li>
</ul>

<h2>3. Supported Networks and Currencies</h2>
<ul>
  <li>The list of supported cryptocurrencies and networks is determined by CryptoCloud;</li>
  <li>The current list is available on the payment page;</li>
  <li>ProgreSQL administration does not control or limit the list of supported networks.</li>
</ul>

<h2>4. Fees</h2>
<ul>
  <li>Blockchain network fees (gas fees) are paid by the User;</li>
  <li>CryptoCloud payment provider fees are included in the price or listed separately on the payment page;</li>
  <li>ProgreSQL administration does not charge additional fees.</li>
</ul>

<h2>5. Responsibility for Network Selection</h2>
<p><strong>The User bears full responsibility for selecting the correct network when sending funds.</strong></p>
<ul>
  <li>Sending funds to an unsupported network or incorrect address may result in irreversible loss of funds;</li>
  <li>ProgreSQL administration is not responsible for funds lost due to incorrect network or address selection;</li>
  <li>It is recommended to send a test transaction before a large transfer.</li>
</ul>

<h2>6. Payment Confirmation</h2>
<ul>
  <li>Payment is considered confirmed after receiving the required number of blockchain confirmations;</li>
  <li>The number of confirmations is determined by CryptoCloud for each network;</li>
  <li>Confirmation time depends on network congestion and may range from minutes to hours;</li>
  <li>Subscription activates automatically after server-side payment confirmation (CryptoCloud webhook).</li>
</ul>

<h2>7. Contact</h2>
<p>For payment inquiries: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 5. REFUND POLICY — Russian
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'refunds', '1.0',
  'Политика возвратов',
  'ru',
  '<h1>Политика возвратов</h1>
<p><strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 20 марта 2026 г.<br><strong>Последнее обновление:</strong> 20 марта 2026 г.</p>

<h2>1. Общие положения</h2>
<p>Настоящая Политика возвратов регулирует условия и порядок возврата средств за подписку на сервис ProgreSQL, оплаченную криптовалютой через CryptoCloud.</p>

<h2>2. Когда возврат возможен</h2>
<p>Возврат средств возможен в следующих случаях:</p>
<ul>
  <li><strong>Техническая невозможность использования сервиса</strong> — если после оплаты Pro-подписка не была активирована по вине Администрации в течение 72 часов, и Пользователь обратился в поддержку;</li>
  <li><strong>Двойное списание</strong> — если произошла повторная оплата одного и того же периода подписки.</li>
</ul>

<h2>3. Когда возврат невозможен</h2>
<p>Возврат средств <strong>не производится</strong> в следующих случаях:</p>
<ul>
  <li>Пользователь воспользовался AI-функциями подписки (отправил хотя бы один запрос к AI);</li>
  <li>Прошло более 72 часов с момента активации подписки;</li>
  <li>Средства отправлены на неверный адрес или в неподдерживаемую сеть по ошибке Пользователя;</li>
  <li>Пользователь нарушил Пользовательское соглашение и был заблокирован;</li>
  <li>Пользователь передумал после активации подписки.</li>
</ul>

<h2>4. Порядок обращения за возвратом</h2>
<ol>
  <li>Направьте запрос на <a href="mailto:support@progresql.com">support@progresql.com</a> с темой «Возврат средств»;</li>
  <li>Укажите: email аккаунта, дату оплаты, сумму, причину возврата;</li>
  <li>Приложите идентификатор транзакции (tx hash), если имеется.</li>
</ol>

<h2>5. Сроки рассмотрения</h2>
<ul>
  <li>Запрос рассматривается в течение 14 рабочих дней;</li>
  <li>При положительном решении возврат осуществляется в течение 30 рабочих дней.</li>
</ul>

<h2>6. Валюта и способ возврата</h2>
<ul>
  <li>Возврат производится в криптовалюте на кошелёк, указанный Пользователем;</li>
  <li>Валюта возврата может отличаться от валюты оплаты (по согласованию);</li>
  <li>Сумма возврата рассчитывается в USD по курсу на дату оплаты;</li>
  <li>Комиссии блокчейн-сети за транзакцию возврата несёт Администрация.</li>
</ul>

<h2>7. Контакты</h2>
<p>По вопросам возвратов: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;


-- ============================================================
-- 5. REFUND POLICY — English
-- ============================================================
INSERT INTO legal_documents (doc_type, version, title, language, content_html, published_at, effective_at, is_active)
VALUES (
  'refunds', '1.0',
  'Refund Policy',
  'en',
  '<h1>Refund Policy</h1>
<p><strong>Version:</strong> 1.0<br><strong>Effective date:</strong> March 20, 2026<br><strong>Last updated:</strong> March 20, 2026</p>

<h2>1. General Provisions</h2>
<p>This Refund Policy governs the conditions and procedures for refunding ProgreSQL subscription payments made in cryptocurrency via CryptoCloud.</p>

<h2>2. When Refunds Are Possible</h2>
<p>Refunds are possible in the following cases:</p>
<ul>
  <li><strong>Technical inability to use the service</strong> — if the Pro subscription was not activated due to Administration''s fault within 72 hours after payment, and the User contacted support;</li>
  <li><strong>Duplicate charge</strong> — if a repeated payment was made for the same subscription period.</li>
</ul>

<h2>3. When Refunds Are Not Possible</h2>
<p>Refunds are <strong>not provided</strong> in the following cases:</p>
<ul>
  <li>The User has used AI features of the subscription (sent at least one AI request);</li>
  <li>More than 72 hours have passed since subscription activation;</li>
  <li>Funds were sent to an incorrect address or unsupported network due to User error;</li>
  <li>The User violated the Terms of Use and was blocked;</li>
  <li>The User changed their mind after subscription activation.</li>
</ul>

<h2>4. Refund Request Procedure</h2>
<ol>
  <li>Send a request to <a href="mailto:support@progresql.com">support@progresql.com</a> with subject "Refund Request";</li>
  <li>Include: account email, payment date, amount, reason for refund;</li>
  <li>Attach the transaction identifier (tx hash) if available.</li>
</ol>

<h2>5. Processing Time</h2>
<ul>
  <li>Requests are reviewed within 14 business days;</li>
  <li>If approved, the refund is processed within 30 business days.</li>
</ul>

<h2>6. Refund Currency and Method</h2>
<ul>
  <li>Refunds are made in cryptocurrency to the wallet specified by the User;</li>
  <li>The refund currency may differ from the payment currency (by agreement);</li>
  <li>The refund amount is calculated in USD at the exchange rate on the payment date;</li>
  <li>Blockchain network fees for the refund transaction are covered by the Administration.</li>
</ul>

<h2>7. Contact</h2>
<p>For refund inquiries: <a href="mailto:support@progresql.com">support@progresql.com</a></p>',
  NOW(), NOW(), TRUE
)
ON CONFLICT (doc_type, version, language) DO UPDATE SET
  content_html = EXCLUDED.content_html,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at;
