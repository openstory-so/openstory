import { PRIVACY_EMAIL, SITE_CONFIG } from '@/shared/marketing/constants';
import { createFileRoute } from '@tanstack/react-router';

const title = `Privacy Policy — ${SITE_CONFIG.name}`;

export const Route = createFileRoute('/_app/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title },
      { property: 'og:title', content: title },
      { property: 'og:url', content: `${SITE_CONFIG.url}/privacy` },
      { name: 'twitter:title', content: title },
    ],
  }),
});

function JurisdictionTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 inline-block rounded border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
      {children}
    </span>
  );
}

function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        Legal
      </p>
      <h1 className="mt-2 font-heading text-4xl font-bold tracking-tight">
        Privacy Policy
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Effective 16 March 2026 &middot; Last updated 16 March 2026
      </p>

      {/* 1. Introduction */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          1. Introduction
        </h2>
        <p className="mt-4 leading-relaxed">
          {SITE_CONFIG.name} (&ldquo;we&rdquo;, &ldquo;us&rdquo;,
          &ldquo;our&rdquo;) is an AI-powered video generation platform that
          transforms film scripts into complete video productions. We are
          committed to protecting the privacy of individuals who use our
          platform, visit our website, or otherwise interact with us.
        </p>
        <p className="mt-4 leading-relaxed">
          This Privacy Policy explains how we collect, use, disclose, store, and
          protect personal information in accordance with:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            The <strong>Privacy Act 1988 (Cth)</strong>, the{' '}
            <strong>Australian Privacy Principles</strong> (&ldquo;APPs&rdquo;),
            and the{' '}
            <strong>Privacy and Other Legislation Amendment Act 2024</strong>{' '}
            (Australia)
          </li>
          <li>
            The{' '}
            <strong>General Data Protection Regulation (EU) 2016/679</strong>{' '}
            (&ldquo;GDPR&rdquo;), where we offer services to individuals in the
            European Economic Area (&ldquo;EEA&rdquo;) or United Kingdom
          </li>
          <li>
            Applicable <strong>US state privacy laws</strong>, including the
            California Consumer Privacy Act as amended by the CPRA
            (&ldquo;CCPA&rdquo;), to the extent their thresholds are met
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          Where provisions apply only to users in a particular jurisdiction, we
          indicate this with a label.
        </p>
        <div className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed">
          <p>
            <strong>Entity:</strong> {SITE_CONFIG.name} is a registered trading
            name operated by a sole trader in New South Wales, Australia.
          </p>
          <p className="mt-1">
            <strong>Contact:</strong>{' '}
            <a
              href={`mailto:${PRIVACY_EMAIL}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {PRIVACY_EMAIL}
            </a>
          </p>
          <p className="mt-1">
            <strong>Website:</strong>{' '}
            <a
              href={SITE_CONFIG.url}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {SITE_CONFIG.url}
            </a>
          </p>
        </div>
      </section>

      {/* 2. Scope */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">2. Scope</h2>
        <p className="mt-4 leading-relaxed">
          This Privacy Policy applies to personal information collected through:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            The {SITE_CONFIG.name} platform and web application (
            <a
              href={SITE_CONFIG.url}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {SITE_CONFIG.url}
            </a>
            )
          </li>
          <li>Our application programming interfaces (APIs)</li>
          <li>Communications with us, including email and support channels</li>
          <li>Any related services, tools, or features we provide</li>
        </ul>
      </section>

      {/* 3. What Is Personal Information */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          3. What Is Personal Information
        </h2>
        <p className="mt-4 leading-relaxed">
          Under the Australian Privacy Act,{' '}
          <strong>personal information</strong> means information or an opinion
          about an identified individual, or an individual who is reasonably
          identifiable, whether the information or opinion is true or not and
          whether it is recorded in a material form or not. Following the 2024
          amendments, this definition encompasses technical identifiers such as
          IP addresses where they can be used to reasonably identify an
          individual.
        </p>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> Under the GDPR,{' '}
          <strong>personal data</strong> means any information relating to an
          identified or identifiable natural person. An identifiable person is
          one who can be identified, directly or indirectly, by reference to an
          identifier such as a name, identification number, location data, or
          online identifier.
        </p>
      </section>

      {/* 4. Information We Collect */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          4. Information We Collect
        </h2>

        <h3 className="mt-6 text-lg font-semibold">
          4.1 Information You Provide Directly
        </h3>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Account information:</strong> name, email address, password
            (stored in hashed form), and account preferences.
          </li>
          <li>
            <strong>Payment information:</strong> billing address and payment
            details. Payment card information is processed by our third-party
            payment processor and is not stored on our servers.
          </li>
          <li>
            <strong>Content and scripts:</strong> film scripts, scene
            descriptions, character descriptions, creative briefs, and other
            content you upload or input for video generation.
          </li>
          <li>
            <strong>Communications:</strong> messages you send to us via email,
            support requests, or feedback forms.
          </li>
        </ul>

        <h3 className="mt-6 text-lg font-semibold">
          4.2 Information Collected Automatically
        </h3>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Usage data:</strong> features used, actions taken,
            generation history, timestamps, and session duration.
          </li>
          <li>
            <strong>Device and technical data:</strong> IP address, browser type
            and version, operating system, device identifiers, and screen
            resolution.
          </li>
          <li>
            <strong>Log data:</strong> server logs recording access times, pages
            viewed, referring URLs, and error reports.
          </li>
          <li>
            <strong>Cookies and similar technologies:</strong> we use cookies,
            local storage, and similar tracking technologies to operate and
            improve the platform (see Section 17).
          </li>
        </ul>

        <h3 className="mt-6 text-lg font-semibold">
          4.3 Information from Third Parties
        </h3>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Authentication providers:</strong> if you sign in using a
            third-party service (e.g., Google), we receive your name, email, and
            profile picture as authorised by you.
          </li>
          <li>
            <strong>Analytics providers:</strong> aggregated and pseudonymised
            usage analytics.
          </li>
        </ul>
      </section>

      {/* 5. How We Use Your Information */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          5. How We Use Your Information
        </h2>
        <p className="mt-4 leading-relaxed">
          We collect and use personal information only for purposes that are
          reasonably necessary for, or directly related to, our functions and
          activities (APP 6). These purposes include:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Providing and operating the platform:</strong> processing
            your scripts, generating video content, managing your account, and
            delivering our services.
          </li>
          <li>
            <strong>AI processing:</strong> analysing scripts to identify
            scenes, characters, and visual elements, and generating images,
            video, and motion content using AI models (see Section 7).
          </li>
          <li>
            <strong>Improving our services:</strong> analysing usage patterns,
            diagnosing technical issues, developing new features, and enhancing
            platform performance.
          </li>
          <li>
            <strong>Communications:</strong> sending service-related notices,
            responding to inquiries, and providing customer support.
          </li>
          <li>
            <strong>Security and fraud prevention:</strong> detecting,
            preventing, and addressing security incidents, fraud, and abuse.
          </li>
          <li>
            <strong>Legal compliance:</strong> complying with applicable laws,
            regulations, legal processes, or enforceable governmental requests.
          </li>
          <li>
            <strong>Marketing (with consent):</strong> sending promotional
            communications where you have opted in. You may opt out at any time.
          </li>
        </ul>
      </section>

      {/* 6. Lawful Basis for Processing (GDPR) */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          6. Lawful Basis for Processing (GDPR)
        </h2>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> Under the GDPR, we must have a
          lawful basis for each processing activity involving personal data of
          individuals in the EEA or UK.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          6.1 Performance of a Contract (Article 6(1)(b))
        </h3>
        <p className="mt-4 leading-relaxed">
          Processing necessary to perform our contract with you: creating and
          managing your account, processing scripts and generating video
          content, processing payments, and providing customer support.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          6.2 Legitimate Interests (Article 6(1)(f))
        </h3>
        <p className="mt-4 leading-relaxed">
          Processing necessary for our legitimate interests where not overridden
          by your rights: improving and optimising the platform, ensuring
          security and preventing fraud, enforcing our terms of service, and
          administrative purposes. You have the right to object to this
          processing (see Section 13).
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          6.3 Consent (Article 6(1)(a))
        </h3>
        <p className="mt-4 leading-relaxed">
          Where we rely on your consent: sending marketing communications and
          placing non-essential cookies. You may withdraw consent at any time
          without affecting the lawfulness of prior processing.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          6.4 Legal Obligation (Article 6(1)(c))
        </h3>
        <p className="mt-4 leading-relaxed">
          Processing necessary to comply with legal obligations: tax reporting,
          responding to lawful government requests, and data breach notification
          requirements.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          6.5 Data Protection Impact Assessment
        </h3>
        <p className="mt-4 leading-relaxed">
          We have conducted a Data Protection Impact Assessment (DPIA) for our
          use of AI models to process user-submitted content, as required under
          GDPR Article 35 for processing that uses innovative technologies and
          may result in high risk to data subjects. A summary is available on
          request.
        </p>
      </section>

      {/* 7. AI Processing & Transparency */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          7. AI Processing &amp; Transparency
        </h2>
        <p className="mt-4 leading-relaxed">
          {SITE_CONFIG.name} uses artificial intelligence and machine learning
          systems to analyse scripts, generate visual content, and produce video
          outputs.
        </p>

        <h3 className="mt-6 text-lg font-semibold">7.1 How We Use AI</h3>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            Large language models (LLMs) analyse your script content, identify
            scenes, generate character descriptions, and create visual prompts.
          </li>
          <li>
            Image generation models create character sheets, scene images, and
            visual assets.
          </li>
          <li>
            Video generation models produce motion content and assemble final
            video outputs.
          </li>
          <li>
            You retain the ability to review, modify, and regenerate any
            AI-produced output.
          </li>
          <li>
            No automated process is used to deny you access to our services or
            to make decisions that produce legal effects concerning you.
          </li>
        </ul>

        <h3 className="mt-6 text-lg font-semibold">
          7.2 Third-Party AI Providers
        </h3>
        <p className="mt-4 leading-relaxed">
          Your content is processed by the following categories of third-party
          AI service providers. We maintain Data Processing Agreements (DPAs)
          with each provider.
        </p>
        <div className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed">
          <p>
            <strong>Large Language Models:</strong> Anthropic (Claude) — script
            analysis, scene breakdown, and prompt generation. Processed via API
            under zero-data-retention terms; not used for model training.
          </p>
          <p className="mt-2">
            <strong>Image Generation:</strong> Provider(s) for character sheet
            and scene image generation. Processed via API under DPAs; not used
            for model training.
          </p>
          <p className="mt-2">
            <strong>Video Generation:</strong> Provider(s) for motion content
            generation. Processed via API under DPAs; not used for model
            training.
          </p>
        </div>
        <p className="mt-4 leading-relaxed">
          Each DPA includes purpose limitation, data retention limits,
          sub-processor notification, breach notification, audit rights, and
          deletion on termination. We will update this section as provider
          relationships change.
        </p>

        <h3 className="mt-6 text-lg font-semibold">7.3 Training Data</h3>
        <p className="mt-4 leading-relaxed">
          <strong>
            We do not use your scripts, content, or personal information to
            train AI models.
          </strong>{' '}
          Your content is processed solely for generating outputs you have
          requested. Our third-party AI providers operate under API terms that
          exclude customer data from model training.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          7.4 AI-Generated Content Labeling
        </h3>
        <p className="mt-4 leading-relaxed">
          We are implementing measures to ensure AI-generated video content is
          marked in a machine-readable format as AI-generated (using C2PA
          metadata standards where technically feasible), identifiable as
          artificially generated content, and labeled visibly where required by
          applicable law. These measures are being implemented ahead of the EU
          AI Act Article 50 transparency deadline of 2 August 2026.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          7.5 Australian ADM Transparency
        </h3>
        <p className="mt-4 leading-relaxed">
          In compliance with the automated decision-making transparency
          requirements under the Privacy and Other Legislation Amendment Act
          2024 (effective 10 December 2026), our AI systems process account
          identifiers, script content, and usage data. These automated processes
          determine scene breakdowns, character generation, visual prompts, and
          video assembly. They are core to service delivery and do not make
          decisions that could reasonably be expected to significantly affect
          your rights or interests beyond generating creative content based on
          your inputs.
        </p>
      </section>

      {/* 8. Disclosure of Personal Information */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          8. Disclosure of Personal Information
        </h2>
        <p className="mt-4 leading-relaxed">
          We may disclose personal information to:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Service providers:</strong> cloud hosting, payment
            processors, email delivery, and analytics providers who process data
            on our behalf under contractual obligations.
          </li>
          <li>
            <strong>AI model providers:</strong> third-party AI services (see
            Section 7.2).
          </li>
          <li>
            <strong>Professional advisors:</strong> lawyers, accountants, and
            auditors where necessary.
          </li>
          <li>
            <strong>Law enforcement and regulators:</strong> where required by
            law, court order, or regulatory obligation.
          </li>
          <li>
            <strong>Business transfers:</strong> in connection with a sale or
            transfer of the business.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          <strong>We do not sell your personal information.</strong> We do not
          share personal information for cross-context behavioural advertising.
        </p>
      </section>

      {/* 9. International Data Transfers */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          9. International Data Transfers
        </h2>
        <p className="mt-4 leading-relaxed">
          {SITE_CONFIG.name} is based in Australia and operates cloud
          infrastructure and third-party services in multiple countries. Your
          personal information may be transferred to and processed in:
        </p>
        <div className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed">
          <p>
            <strong>Australia:</strong> Primary business operations.
          </p>
          <p className="mt-1">
            <strong>United States:</strong> Cloud infrastructure, AI model
            providers, payment processing, and analytics.
          </p>
          <p className="mt-1">
            <strong>Other countries:</strong> Where our service providers
            maintain data centres.
          </p>
        </div>

        <h3 className="mt-6 text-lg font-semibold">
          9.1 Safeguards for Australian Users (APP 8)
        </h3>
        <p className="mt-4 leading-relaxed">
          Before disclosing personal information to an overseas recipient, we
          take reasonable steps to ensure the recipient handles the information
          in accordance with the APPs, through contractual arrangements and data
          processing agreements.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          9.2 Safeguards for EEA/UK Users
        </h3>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> Australia does not have an EU
          adequacy decision. For transfers of personal data from the EEA or UK,
          we rely on:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Standard Contractual Clauses (SCCs):</strong> European
            Commission SCCs (module 2: controller-to-processor) with service
            providers and AI model providers, supplemented by additional
            technical and organisational measures where necessary.
          </li>
          <li>
            <strong>EU-US Data Privacy Framework:</strong> Where our US-based
            providers are certified under the Framework.
          </li>
          <li>
            <strong>Transfer Impact Assessments:</strong> We conduct TIAs to
            evaluate the legal framework in each destination country and
            implement supplementary measures where risks are identified.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          You may request a copy of the relevant transfer safeguards by
          contacting{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>
          .
        </p>
      </section>

      {/* 10. Data Retention */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          10. Data Retention
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Account information:</strong> retained for the duration of
            your account and 12 months after deletion, unless a longer period is
            required by law.
          </li>
          <li>
            <strong>Generated content:</strong> retained while your account is
            active. Deleted within 90 days of account deletion.
          </li>
          <li>
            <strong>Usage and log data:</strong> retained for up to 24 months,
            then aggregated or deleted.
          </li>
          <li>
            <strong>Payment records:</strong> retained for 7 years as required
            by Australian taxation law.
          </li>
          <li>
            <strong>Support communications:</strong> retained for 24 months
            after resolution.
          </li>
          <li>
            <strong>AI provider processing:</strong> providers do not retain
            input or output data beyond the API request (zero-data-retention).
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          When personal information is no longer needed, we take reasonable
          steps to destroy or de-identify it (APP 11.2).
        </p>
      </section>

      {/* 11. Data Security */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          11. Data Security
        </h2>
        <p className="mt-4 leading-relaxed">
          We take reasonable technical and organisational measures to protect
          personal information (APP 11.1; GDPR Article 32), including:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>Encryption of data in transit (TLS 1.2+) and at rest</li>
          <li>Access controls and authentication mechanisms</li>
          <li>Regular security assessments and monitoring</li>
          <li>Contractor and staff confidentiality obligations</li>
          <li>Incident response and data breach notification procedures</li>
        </ul>
        <p className="mt-4 leading-relaxed">
          No method of electronic storage or transmission is completely secure.
          While we strive to protect your personal information, we cannot
          guarantee its absolute security.
        </p>
      </section>

      {/* 12. Your Rights — Australia */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          12. Your Rights — Australia
        </h2>

        <h3 className="mt-6 text-lg font-semibold">12.1 Access (APP 12)</h3>
        <p className="mt-4 leading-relaxed">
          You may request access to personal information we hold about you. We
          will respond within 30 days.
        </p>

        <h3 className="mt-6 text-lg font-semibold">12.2 Correction (APP 13)</h3>
        <p className="mt-4 leading-relaxed">
          You may request correction of inaccurate, incomplete, out-of-date,
          irrelevant, or misleading personal information. We will respond within
          30 days.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          12.3 Anonymity and Pseudonymity (APP 2)
        </h3>
        <p className="mt-4 leading-relaxed">
          Where practicable, you may use a pseudonym or choose not to identify
          yourself. However, this may limit access to some platform features.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          12.4 Direct Marketing (APP 7)
        </h3>
        <p className="mt-4 leading-relaxed">
          You may opt out of marketing communications at any time via the
          unsubscribe link or by contacting{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>
          .
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          12.5 Direct Right of Action
        </h3>
        <p className="mt-4 leading-relaxed">
          Under the Privacy and Other Legislation Amendment Act 2024,
          individuals may seek damages directly from APP entities through the
          Federal Court for serious or repeated interferences with privacy,
          without first needing to lodge a complaint with the OAIC.
        </p>
      </section>

      {/* 13. Your Rights — EU/EEA (GDPR) */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          13. Your Rights — EU/EEA (GDPR)
        </h2>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> If you are located in the EEA
          or UK, you have the following rights. Contact{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>{' '}
          to exercise them. We will respond within 30 days.
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Access (Article 15):</strong> Obtain confirmation of
            processing and a copy of your personal data.
          </li>
          <li>
            <strong>Rectification (Article 16):</strong> Correct inaccurate or
            incomplete data.
          </li>
          <li>
            <strong>Erasure (Article 17):</strong> Request deletion where data
            is no longer necessary, you withdraw consent, you object to
            processing, or data was unlawfully processed.
          </li>
          <li>
            <strong>Restriction (Article 18):</strong> Request restricted
            processing while accuracy is verified, if processing is unlawful, or
            pending an objection assessment.
          </li>
          <li>
            <strong>Portability (Article 20):</strong> Receive your data in a
            structured, machine-readable format and transmit it to another
            controller.
          </li>
          <li>
            <strong>Object (Article 21):</strong> Object to processing based on
            legitimate interests. You have an absolute right to object to direct
            marketing.
          </li>
          <li>
            <strong>Automated decisions (Article 22):</strong> Not be subject to
            solely automated decisions producing legal or similarly significant
            effects. Our AI processing generates creative content and does not
            produce such effects.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          You may lodge a complaint with your local supervisory authority. A
          full list is at{' '}
          <a
            href="https://edpb.europa.eu/about-edpb/about-edpb/members_en"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            edpb.europa.eu
          </a>
          .
        </p>

        <h3 className="mt-6 text-lg font-semibold">EU Representative</h3>
        <p className="mt-4 leading-relaxed">
          Under GDPR Article 27, non-EU controllers must appoint a
          representative in the EU. We will appoint an EU representative and
          update this section with their contact details as we scale our
          services to EEA users. In the meantime, all privacy enquiries can be
          directed to{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>
          .
        </p>
      </section>

      {/* 14. Your Rights — United States */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          14. Your Rights — United States
        </h2>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>US</JurisdictionTag> Several US states have enacted
          comprehensive privacy laws, including California (CCPA/CPRA), Texas
          (TDPSA), Colorado, Connecticut, Virginia, and others. The
          applicability of these laws depends on whether specific thresholds are
          met (e.g., revenue, volume of consumers, or data sales). As{' '}
          {SITE_CONFIG.name} grows, we are committed to complying with all
          applicable US state privacy requirements. This section describes the
          rights we will honour for US users.
        </p>

        <h3 className="mt-6 text-lg font-semibold">14.1 Your Rights</h3>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Right to Know / Access:</strong> Know what personal
            information we collect, use, and disclose, and request a copy.
          </li>
          <li>
            <strong>Right to Delete:</strong> Request deletion of personal
            information, subject to legal exceptions.
          </li>
          <li>
            <strong>Right to Correct:</strong> Request correction of inaccurate
            personal information.
          </li>
          <li>
            <strong>Right to Opt Out of Sale or Sharing:</strong> We do not sell
            personal information or share it for cross-context behavioural
            advertising.
          </li>
          <li>
            <strong>Right to Non-Discrimination:</strong> We will not
            discriminate against you for exercising your rights.
          </li>
        </ul>

        <h3 className="mt-6 text-lg font-semibold">
          14.2 How to Exercise Your Rights
        </h3>
        <p className="mt-4 leading-relaxed">
          Email{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>{' '}
          with your request. We will verify your identity and respond within 45
          days.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          14.3 Global Privacy Control
        </h3>
        <p className="mt-4 leading-relaxed">
          We honour the Global Privacy Control (GPC) signal. When we detect a
          GPC signal from your browser, we treat it as a valid opt-out request
          for the sale or sharing of personal information.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          14.4 California Disclosures
        </h3>
        <p className="mt-4 leading-relaxed">
          If and when CCPA thresholds are met, we will maintain a full set of
          California-specific disclosures including categories of personal
          information collected and disclosed, a &ldquo;Do Not Sell or
          Share&rdquo; mechanism, and CCPA-specific metrics. We do not currently
          meet CCPA applicability thresholds.
        </p>
      </section>

      {/* 15. Statutory Tort for Serious Invasions of Privacy */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          15. Statutory Tort for Serious Invasions of Privacy
        </h2>
        <p className="mt-4 leading-relaxed">
          From 10 June 2025, Australia&rsquo;s statutory tort for serious
          invasions of privacy (Schedule 2 of the Privacy and Other Legislation
          Amendment Act 2024) provides individuals with a personal right of
          action where their privacy has been seriously invaded through
          intrusion upon seclusion or misuse of personal information. This
          applies regardless of entity turnover. We have implemented measures to
          prevent any conduct that could constitute a serious invasion of
          privacy.
        </p>
      </section>

      {/* 16. Children's Privacy */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          16. Children&rsquo;s Privacy
        </h2>
        <p className="mt-4 leading-relaxed">
          {SITE_CONFIG.name} is not directed at children. We do not knowingly
          collect personal information from children without appropriate
          consent.
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Australia:</strong> Users must be at least 18 years of age,
            or have parental consent, to create an account. We are monitoring
            Australia&rsquo;s Children&rsquo;s Online Privacy Code (to be
            registered by 10 December 2026).
          </li>
          <li>
            <strong>EU:</strong> Users must meet the minimum age for consent in
            their Member State (13&ndash;16 depending on country). Below that
            age, consent must come from a parent or guardian.
          </li>
          <li>
            <strong>US:</strong> We comply with COPPA and do not knowingly
            collect personal information from children under 13. The FTC&rsquo;s
            amended COPPA Rule (compliance deadline 22 April 2026) broadens the
            definition of personal information and strengthens protections.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          If we become aware that we have collected personal information from a
          child without appropriate consent, we will delete that information
          promptly.
        </p>
      </section>

      {/* 17. Cookies & Tracking Technologies */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          17. Cookies &amp; Tracking Technologies
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-relaxed">
          <li>
            <strong>Strictly necessary:</strong> essential for authentication
            and security.
          </li>
          <li>
            <strong>Functional:</strong> remembering your preferences and
            settings.
          </li>
          <li>
            <strong>Analytics:</strong> understanding how users interact with
            the platform.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> For EEA/UK users,
          non-essential cookies are only placed with your prior consent. You can
          manage preferences through the cookie banner or your account settings.
        </p>
        <p className="mt-4 leading-relaxed">
          You can manage cookies through your browser settings. We honour the
          Global Privacy Control signal as a cookie opt-out where required by
          law.
        </p>
      </section>

      {/* 18. Notifiable Data Breaches */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          18. Notifiable Data Breaches
        </h2>

        <h3 className="mt-6 text-lg font-semibold">
          Australia (Part IIIC, Privacy Act)
        </h3>
        <p className="mt-4 leading-relaxed">
          We will assess suspected breaches within 30 days and notify the OAIC
          and affected individuals as soon as practicable if the breach is
          likely to result in serious harm.
        </p>

        <h3 className="mt-6 text-lg font-semibold">
          EU/EEA (GDPR Articles 33&ndash;34)
        </h3>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>GDPR</JurisdictionTag> We will notify the relevant
          supervisory authority within 72 hours. Where a breach poses high risk
          to individuals, we will also notify affected data subjects without
          undue delay.
        </p>

        <h3 className="mt-6 text-lg font-semibold">United States</h3>
        <p className="mt-4 leading-relaxed">
          <JurisdictionTag>US</JurisdictionTag> We will comply with applicable
          state data breach notification laws.
        </p>
      </section>

      {/* 19. Complaints */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          19. Complaints
        </h2>
        <p className="mt-4 leading-relaxed">
          If you believe we have breached applicable privacy laws, contact{' '}
          <a
            href={`mailto:${PRIVACY_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRIVACY_EMAIL}
          </a>
          . We will acknowledge within 5 business days, investigate and respond
          within 30 days.
        </p>
        <p className="mt-4 leading-relaxed">
          If unsatisfied, you may escalate to:
        </p>
        <div className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed">
          <p>
            <strong>Australia:</strong> Office of the Australian Information
            Commissioner (OAIC) —{' '}
            <a
              href="https://www.oaic.gov.au"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              www.oaic.gov.au
            </a>{' '}
            &middot; 1300&nbsp;363&nbsp;992 &middot; GPO Box 5218, Sydney NSW
            2001
          </p>
          <p className="mt-2">
            <strong>EU/EEA:</strong> Your local supervisory authority —{' '}
            <a
              href="https://edpb.europa.eu/about-edpb/about-edpb/members_en"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              edpb.europa.eu
            </a>
          </p>
          <p className="mt-2">
            <strong>US:</strong> Your state attorney general&rsquo;s office or
            the FTC at{' '}
            <a
              href="https://www.ftc.gov"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              www.ftc.gov
            </a>
          </p>
        </div>
      </section>

      {/* 20. Changes to This Policy */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          20. Changes to This Policy
        </h2>
        <p className="mt-4 leading-relaxed">
          We may update this Policy to reflect changes in our practices,
          technology, or legal requirements. Material changes will be posted on
          our website with an updated &ldquo;Last Updated&rdquo; date. Where
          required by law, we will seek your consent before materially changing
          how we process your personal information.
        </p>
      </section>

      {/* 21. Contact Us */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">
          21. Contact Us
        </h2>
        <div className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm leading-relaxed">
          <p className="font-semibold">{SITE_CONFIG.name} — Data Controller</p>
          <p className="mt-1">
            Email:{' '}
            <a
              href={`mailto:${PRIVACY_EMAIL}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {PRIVACY_EMAIL}
            </a>
          </p>
          <p className="mt-1">
            Website:{' '}
            <a
              href={SITE_CONFIG.url}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {SITE_CONFIG.url}
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
