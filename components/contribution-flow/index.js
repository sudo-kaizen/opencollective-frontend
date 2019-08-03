import React from 'react';
import PropTypes from 'prop-types';
import { FormattedMessage, injectIntl, defineMessages } from 'react-intl';
import { graphql, compose } from 'react-apollo';
import gql from 'graphql-tag';
import { debounce, get, pick, isNil } from 'lodash';
import { Box, Flex } from '@rebass/grid';
import styled from 'styled-components';
import { isURL } from 'validator';
import uuid from 'uuid/v4';
import * as LibTaxes from '@opencollective/taxes';

import { OPENSOURCE_COLLECTIVE_ID } from '../../lib/constants/collectives';
import { VAT_OPTIONS } from '../../lib/constants/vat';
import { Router } from '../../server/pages';
import { stripeTokenToPaymentMethod } from '../../lib/stripe';
import { formatCurrency, getEnvVar, parseToBoolean } from '../../lib/utils';
import { getPaypal } from '../../lib/paypal';
import { getRecaptcha, getRecaptchaSiteKey, unloadRecaptcha } from '../../lib/recaptcha';
import { addCreateCollectiveMutation } from '../../lib/graphql/mutations';

import { H5 } from '../Text';
import ContributeAsFAQ from '../faqs/ContributeAsFAQ';
import StyledInputField from '../StyledInputField';
import { withStripeLoader } from '../StripeProvider';
import { withUser } from '../UserProvider';
import Loading from '../Loading';
import StyledButton from '../StyledButton';
import PayWithPaypalButton from '../PayWithPaypalButton';
import ContributeDetailsFAQ from '../faqs/ContributeDetailsFAQ';
import Container from '../Container';
import { fadeIn } from '../StyledKeyframes';
import MessageBox from '../MessageBox';
import SignInOrJoinFree from '../SignInOrJoinFree';
import Steps from '../Steps';
import EventDetails from '../EventDetails';

import Cover from './Cover';
import ContributionFlowStepsProgress from './ContributionFlowStepsProgress';
import ContributionDetails from './ContributionDetails';
import StepProfile from './StepProfile';
import StepDetails from './StepDetails';
import StepBreakdown from './StepBreakdown';
import StepPayment from './StepPayment';

// Styles for the previous, next and submit buttons
const PrevNextButton = styled(StyledButton)`
  animation: ${fadeIn} 0.3s;
`;

PrevNextButton.defaultProps = {
  buttonSize: 'large',
  fontWeight: 'bold',
  minWidth: '255px',
  m: 2,
};

// Styles for Paypal button
const PaypalButtonContainer = styled(Box)`
  animation: ${fadeIn} 0.3s;
`;
PaypalButtonContainer.defaultProps = {
  width: PrevNextButton.defaultProps.minWidth,
  m: PrevNextButton.defaultProps.m,
};

const recaptchaEnabled = parseToBoolean(getEnvVar('RECAPTCHA_ENABLED'));

const messages = defineMessages({
  manualPm: {
    id: 'host.paymentMethod.manual.instructions',
    defaultMessage:
      'Instructions to make the payment of {amount} will be sent to your email address {email}. Your order will be pending until the funds have been received by the host ({host}).',
  },
});

/**
 * Main contribution flow entrypoint. Render all the steps from contributeAs
 * to payment.
 */
class CreateOrderPage extends React.Component {
  static propTypes = {
    collective: PropTypes.shape({
      id: PropTypes.number.isRequired,
      type: PropTypes.string.isRequired,
      slug: PropTypes.string.isRequired,
      currency: PropTypes.string.isRequired,
      hostFeePercent: PropTypes.number.isRequired,
      location: PropTypes.shape({ country: PropTypes.string }),
      parentCollective: PropTypes.shape(),
    }).isRequired,
    host: PropTypes.shape({
      id: PropTypes.number.isRequired,
      name: PropTypes.string.isRequired,
      location: PropTypes.shape({ country: PropTypes.string }),
      settings: PropTypes.object,
    }).isRequired,
    tier: PropTypes.shape(),
    verb: PropTypes.string.isRequired,
    step: PropTypes.string,
    referral: PropTypes.string,
    redirect: PropTypes.string,
    description: PropTypes.string,
    interval: PropTypes.string,
    fixedAmount: PropTypes.number,
    customData: PropTypes.object,
    defaultQuantity: PropTypes.number,
    LoggedInUser: PropTypes.object, // from withUser
    loadingLoggedInUser: PropTypes.bool, // from withUser
    refetchLoggedInUser: PropTypes.func.isRequired, // from withUser
    createOrder: PropTypes.func.isRequired, // from mutation
    createCollective: PropTypes.func.isRequired, // from mutation
    loadStripe: PropTypes.func.isRequired, // from withStripe
    intl: PropTypes.object.isRequired, // from injectIntl
  };

  static defaultProps = {
    defaultQuantity: 1,
    verb: 'contribute',
  };

  static errorRecaptchaConnect = "Can't connect to ReCaptcha. Try to reload the page, or disable your Ad Blocker.";

  constructor(props) {
    super(props);
    this.recaptcha = null;
    this.recaptchaToken = null;
    this.activeFormRef = React.createRef();
    this.state = {
      loading: false,
      submitting: false,
      submitted: false,
      stepProfile: this.getLoggedInUserDefaultContibuteProfile(),
      stepDetails: null,
      stepPayment: null,
      stepSummary: null,
      error: null,
      stripe: null,
      customData: {},
    };
  }

  async componentDidMount() {
    this.loadInitialData();
    // Load payment providers scripts in the background
    this.props.loadStripe();
    if (this.hasPaypal()) {
      getPaypal();
    }

    if (recaptchaEnabled) {
      try {
        this.recaptcha = await getRecaptcha();
      } catch {
        this.setState({ error: CreateOrderPage.errorRecaptchaConnect });
      }
    }
  }

  componentDidUpdate(prevProps) {
    // Set user as default profile when loggin in
    if (!prevProps.LoggedInUser && this.props.LoggedInUser && !this.state.stepProfile) {
      this.setState({ stepProfile: this.getLoggedInUserDefaultContibuteProfile() });
    }

    // Collective was loaded
    if (prevProps.collective !== this.props.collective) {
      this.loadInitialData();
      if (this.hasPaypal()) {
        getPaypal();
      }
    }
  }

  componentWillUnmount() {
    if (recaptchaEnabled) {
      unloadRecaptcha();
    }
  }

  loadInitialData() {
    this.setState(state => ({
      ...state,
      stepProfile: state.stepProfile || this.getLoggedInUserDefaultContibuteProfile(),
      stepDetails: get(state.stepDetails, 'totalAmount')
        ? state.stepDetails
        : this.getDefaultStepDetails(this.props.tier),
      customData: this.props.customData,
    }));
  }

  /** Steps component callback  */
  onStepChange = async step => {
    this.pushStepRoute(step.name);
  };

  /** Navigate to another step, ensuring all route params are preserved */
  pushStepRoute = async (stepName, routeParams = {}) => {
    const { collective, tier } = this.props;

    const params = {
      verb: this.props.verb || 'donate',
      collectiveSlug: collective.slug,
      step: stepName === 'contributeAs' ? undefined : stepName,
      totalAmount: this.props.fixedAmount ? this.props.fixedAmount.toString() : undefined,
      ...pick(this.props, ['interval', 'description', 'redirect', 'eventSlug']),
      ...routeParams,
    };

    let route = 'orderCollectiveNew';
    if (tier) {
      params.tierId = tier.id;
      params.tierSlug = tier.slug;
      if (tier.type === 'TICKET') {
        route = 'orderEventTier';
        params.collectiveSlug = get(collective.parentCollective, 'slug', 'collective');
        params.eventSlug = collective.slug;
      } else {
        route = 'orderCollectiveTierNew';
        params.verb = 'contribute'; // Enforce "contribute" verb for ordering tiers
      }
    }

    // Reset errors if any
    if (this.state.error) {
      this.setState({ error: null });
    }

    // Navigate to the new route
    await Router.pushRoute(stepName === 'success' ? `${route}Success` : route, params);
    window.scrollTo(0, 0);
  };

  fetchRecaptchaToken = () => {
    if (this.recaptchaToken) {
      return Promise.resolve(this.recaptchaToken);
    }

    return new Promise(resolve =>
      this.recaptcha.ready(() =>
        this.recaptcha.execute(getRecaptchaSiteKey(), { action: 'OrderForm' }).then(recaptchaToken => {
          this.recaptchaToken = recaptchaToken;
          resolve(recaptchaToken);
        }),
      ),
    );
  };

  /** Validate step payment, loading data from stripe for new credit cards */
  validateStepPayment = async action => {
    const { stepPayment } = this.state;
    const isFixedContribution = this.isFixedContribution();

    if (action === 'prev') {
      // Don't validate when going back
      return true;
    } else if (this.getOrderMinAmount() === 0 && (isFixedContribution || !stepPayment)) {
      // Always ignore payment method for free tiers
      return true;
    } else if (!stepPayment) {
      this.setState({ error: 'Please set a payment method' });
      return false;
    } else if (!stepPayment.isNew) {
      // No need to validate existing payment methods
      return true;
    } else if (!stepPayment.data && get(stepPayment, 'paymentMethod.token')) {
      // New credit card - if no data, stripe token has already been exchanged
      return true;
    } else {
      // New credit card - load info from stripe
      if (!this.state.stripe) {
        this.setState({
          error: 'There was a problem initializing the payment form. Please reload the page and try again',
        });
        return false;
      }
      const { token, error } = await this.state.stripe.createToken();
      if (error) {
        this.setState({ error: error.message });
        return false;
      }
      this.setState(state => ({
        ...state,
        stepPayment: {
          ...state.stepPayment,
          data: null,
          key: `newCreditCard-${uuid()}`,
          paymentMethod: { ...stripeTokenToPaymentMethod(token), save: this.state.stepPayment.save },
        },
      }));
    }

    return true;
  };

  /** Validate step profile, create new org if necessary */
  validateStepProfile = async () => {
    if (!this.state.stepProfile || !this.activeFormRef.current || !this.activeFormRef.current.reportValidity()) {
      return false;
    }

    // Check if we're creating a new profile
    if (!this.state.stepProfile.id) {
      this.setState({ submitting: true });
      this.state.stepProfile.type = this.state.stepProfile.type || 'ORGANIZATION';

      try {
        const { data: result } = await this.props.createCollective(this.state.stepProfile);
        const createdProfile = result.createCollective;
        await this.props.refetchLoggedInUser();
        this.setState({ stepProfile: createdProfile, submitting: false });
      } catch (error) {
        this.setState({ error: error.message, submitting: false });
        window.scrollTo(0, 0);
        return false;
      }
    }

    return true;
  };

  submitOrder = async (paymentMethodOverride = null) => {
    this.setState({ submitting: true, error: null });
    const { stepProfile, stepDetails, stepPayment, stepSummary, customData } = this.state;

    // Prepare payment method
    let paymentMethod = paymentMethodOverride;
    if (!paymentMethod && stepPayment) {
      paymentMethod = stepPayment.paymentMethod;
      if (!stepPayment.isNew) {
        paymentMethod = pick(paymentMethod, ['service', 'type', 'uuid']);
      }
    }

    // Load recaptcha token
    let recaptchaToken;
    if (recaptchaEnabled) {
      recaptchaToken = await this.fetchRecaptchaToken();
      if (!recaptchaToken) {
        this.setState({ error: CreateOrderPage.errorRecaptchaConnect });
      }
    }

    const tier = this.props.tier;
    const order = {
      paymentMethod,
      recaptchaToken,
      totalAmount: this.getTotalAmountWithTaxes(),
      taxAmount: get(stepSummary, 'amount', 0),
      countryISO: get(stepSummary, 'countryISO'),
      taxIDNumber: get(stepSummary, 'number'),
      quantity: get(stepDetails, 'quantity', 1),
      currency: this.getCurrency(),
      interval: stepDetails.interval,
      referral: this.props.referral,
      fromCollective: pick(stepProfile, ['id', 'type', 'name']),
      collective: pick(this.props.collective, ['id']),
      tier: tier ? pick(tier, ['id', 'amount']) : undefined,
      description: this.props.description || '',
      customData,
    };

    try {
      const res = await this.props.createOrder(order);
      const orderCreated = res.data.createOrder;
      this.setState({ submitting: false, submitted: true, error: null });
      this.props.refetchLoggedInUser();
      if (this.props.redirect && this.isValidRedirect(this.props.redirect)) {
        const orderId = get(orderCreated, 'id', null);
        const transactionId = get(orderCreated, 'transactions[0].id', null);
        const status = orderCreated.status;
        const redirectTo = `${this.props.redirect}?orderId=${orderId}&transactionid=${transactionId}&status=${status}`;
        window.location.href = redirectTo;
      } else {
        this.pushStepRoute('success', { OrderId: orderCreated.id });
      }
    } catch (e) {
      this.setState({ submitting: false, error: e.message });
    }
  };

  isValidRedirect(url) {
    const validationParams = process.env.NODE_ENV === 'production' ? {} : { require_tld: false };
    return isURL(url, validationParams);
  }

  getLoggedInUserDefaultContibuteProfile() {
    if (get(this.state, 'stepProfile')) {
      return this.state.stepProfile;
    }

    const { LoggedInUser } = this.props;
    return !LoggedInUser ? null : { email: LoggedInUser.email, image: LoggedInUser.image, ...LoggedInUser.collective };
  }

  /** Returns an array like [personnalProfile, otherProfiles] */
  getProfiles() {
    const { LoggedInUser, collective } = this.props;

    if (!LoggedInUser) {
      return [{}, {}];
    } else {
      return [
        { email: LoggedInUser.email, image: LoggedInUser.image, ...LoggedInUser.collective },
        LoggedInUser.memberOf
          .filter(m => m.role === 'ADMIN' && m.collective.id !== collective.id && m.collective.type !== 'EVENT')
          .map(({ collective }) => collective),
      ];
    }
  }

  /** Guess the country, from the more pricise method (settings) to the less */
  getContributingProfileCountry() {
    return (
      get(this.state.stepSummary, 'countryISO') ||
      get(this.state.stepProfile, 'location.country') ||
      get(this.props.LoggedInUser, 'collective.location.country')
    );
  }

  /** Returns tier presets, defaults presets, or null if using a tier with fixed amount */
  getAmountsPresets() {
    const tier = this.props.tier || {};
    return tier.presets || (isNil(tier.amount) ? [500, 1000, 2000, 5000] : null);
  }

  /** Get the min authorized amount for order, in cents */
  getOrderMinAmount() {
    const tier = this.props.tier;

    // When making a donation, min amount is $1
    if (!tier) {
      return 100;
    }

    // If the tier has not amount and no preset, it's a free tier
    if (isNil(tier.amount) && isNil(tier.presets)) {
      return 0;
    }

    return tier.minimumAmount;
  }

  getDefaultAmount() {
    const { tier } = this.props;
    const stateAmount = get(this.state.stepDetails, 'totalAmount');

    if (!isNil(stateAmount)) {
      return stateAmount;
    } else if (tier && !isNil(tier.amount)) {
      return tier.amount;
    } else if (!isNil(this.props.fixedAmount)) {
      return this.props.fixedAmount;
    } else if (this.getOrderMinAmount() === 0) {
      // Free tiers are free per default, even when user can make a donation
      return 0;
    }

    const presets = this.getAmountsPresets();
    return presets && presets.length > 0 ? presets[Math.floor(presets.length / 2)] : 500;
  }

  /** Get default total amount, or undefined if we don't have any info on this */
  getDefaultStepDetails(tier) {
    const { stepDetails } = this.state;
    const amount = this.getDefaultAmount();
    const quantity = get(stepDetails, 'quantity') || this.props.defaultQuantity;
    const interval = get(stepDetails, 'interval') || get(tier, 'interval') || this.props.interval;

    return {
      amount,
      quantity,
      interval,
      totalAmount: amount * quantity,
    };
  }

  /** Get total amount based on stepDetails with taxes from step summary applied */
  getTotalAmountWithTaxes() {
    const quantity = get(this.state, 'stepDetails.quantity', 1);
    const amount = get(this.state, 'stepDetails.amount', 0);
    const taxAmount = get(this.state, 'stepSummary.amount', 0);
    return quantity * amount + taxAmount;
  }

  /** Returns true if the price and interval of the current contribution cannot be changed */
  isFixedContribution() {
    const tier = this.props.tier;
    const forceInterval = Boolean(tier) || Boolean(this.props.interval);
    const forceAmount = !get(tier, 'presets') && !isNil(get(tier, 'amount') || this.props.fixedAmount);
    return forceInterval && forceAmount;
  }

  /** Returns true if taxes may apply with this tier/host */
  taxesMayApply() {
    const { tier, collective, host } = this.props;

    if (!tier) {
      return false;
    }

    // Don't apply VAT if not configured (default)
    const vatType = get(collective, 'settings.VAT.type') || get(collective, 'parentCollective.settings.VAT.type');
    const hostCountry = get(host.location, 'country');
    const collectiveCountry = get(collective.location, 'country');
    const parentCountry = get(collective, 'parentCollective.location.country');
    const country = collectiveCountry || parentCountry || hostCountry;

    if (!vatType) {
      return false;
    } else if (vatType === VAT_OPTIONS.OWN) {
      return LibTaxes.getVatOriginCountry(tier.type, country, country);
    } else {
      return LibTaxes.getVatOriginCountry(tier.type, hostCountry, country);
    }
  }

  /** Returns the steps list */
  getSteps() {
    const { stepDetails, stepPayment, stepSummary } = this.state;
    const tier = this.props.tier;
    const isFixedContribution = this.isFixedContribution();
    const minAmount = this.getOrderMinAmount();
    const noPaymentRequired = minAmount === 0 && get(stepDetails, 'amount') === 0;

    const steps = [
      {
        name: 'contributeAs',
        isCompleted: Boolean(this.state.stepProfile),
        validate: this.validateStepProfile,
      },
    ];

    // If amount and interval are forced by a tier or by params, skip StepDetails (except for events)
    if (!isFixedContribution || (tier && tier.type === 'TICKET')) {
      steps.push({
        name: 'details',
        isCompleted: Boolean(stepDetails && stepDetails.totalAmount >= minAmount),
        validate: () => {
          return stepDetails && this.activeFormRef.current && this.activeFormRef.current.reportValidity();
        },
      });
    }

    // Hide step payment if using a free tier with fixed price
    if (!(minAmount === 0 && isFixedContribution)) {
      steps.push({
        name: 'payment',
        isCompleted: Boolean(noPaymentRequired || stepPayment),
        validate: this.validateStepPayment,
      });
    }

    // Show the summary step only if the order has tax
    if (this.taxesMayApply()) {
      steps.push({
        name: 'summary',
        isCompleted: noPaymentRequired || get(stepSummary, 'isReady', false),
      });
    }

    return steps;
  }

  /** Get currency from the current tier, or fallback on collective currency */
  getCurrency() {
    return get(this.props.tier, 'currency', this.props.collective.currency);
  }

  /** Returns manual payment method if supported by the host and not using an interval, null otherwise */
  getManualPaymentMethod() {
    const pm = get(this.props.host.settings, 'paymentMethods.manual');
    if (!pm || get(this.state, 'stepDetails.interval')) {
      return null;
    }

    return {
      ...pm,
      instructions: this.props.intl.formatMessage(messages.manualPm, {
        amount: formatCurrency(get(this.state, 'stepDetails.totalAmount'), this.getCurrency()),
        email: get(this.props, 'LoggedInUser.email', ''),
        host: this.props.host.name,
      }),
    };
  }

  // Debounce state update functions that may be called successively
  updateProfile = debounce(stepProfile => this.setState({ stepProfile, stepPayment: null }), 300);
  updateDetails = stepDetails => this.setState({ stepDetails });

  handleCustomFieldsChange = (name, value) => {
    const { customData } = this.state;

    this.setState({
      customData: {
        ...customData,
        [name]: value,
      },
    });
  };

  /* We only support paypal for one time donations to the open source collective for now. */
  hasPaypal() {
    return this.props.host.id === OPENSOURCE_COLLECTIVE_ID && !get(this.state, 'stepDetails.interval');
  }

  /* We might have problems with postal code and this should be disablable */
  shouldHideCreditCardPostalCode() {
    return get(this.state, 'stepProfile.settings.hideCreditCardPostalCode', false);
  }

  renderStep(step) {
    const { collective, tier, host } = this.props;
    const { stepProfile, stepDetails, stepPayment, customData } = this.state;
    const [personal, profiles] = this.getProfiles();
    const customFields = tier && tier.customFields ? tier.customFields : [];
    const defaultStepDetails = this.getDefaultStepDetails(tier);
    const interval = get(stepDetails, 'interval') || defaultStepDetails.interval;
    const isIncognito = get(stepProfile, 'isIncognito');
    if (step.name === 'contributeAs') {
      return (
        <Flex justifyContent="center" width={1}>
          <Box width={[0, null, null, '24em']} />
          <Container>
            <StyledInputField
              htmlFor="contributeAs"
              label={
                <H5 textAlign="left" mb={3}>
                  <FormattedMessage id="contribute.profile.label" defaultMessage="Contribute As:" />
                </H5>
              }
            >
              {fieldProps => (
                <Container as="form" onSubmit={e => e.preventDefault()} ref={this.activeFormRef}>
                  <StepProfile
                    {...fieldProps}
                    onProfileChange={this.updateProfile}
                    profiles={profiles}
                    personal={personal}
                    defaultSelectedProfile={this.getLoggedInUserDefaultContibuteProfile()}
                  />
                </Container>
              )}
            </StyledInputField>
          </Container>
          <ContributeAsFAQ mt={4} ml={4} display={['none', null, 'block']} width={1 / 5} minWidth="335px" />
        </Flex>
      );
    } else if (step.name === 'details') {
      return (
        <Flex justifyContent="center" width={1}>
          <Box width={[0, null, null, 1 / 5]} />
          <Container
            as="form"
            onSubmit={e => e.preventDefault()}
            ref={this.activeFormRef}
            mx={5}
            width={[0.95, null, 3 / 5]}
            maxWidth="465px"
          >
            <H5 textAlign="left" mb={3}>
              <FormattedMessage id="contribute.details.label" defaultMessage="Contribution Details:" />
            </H5>
            <StepDetails
              amountOptions={this.props.fixedAmount ? null : this.getAmountsPresets()}
              currency={this.getCurrency()}
              onChange={this.updateDetails}
              interval={interval}
              amount={get(stepDetails, 'amount') || defaultStepDetails.amount}
              quantity={get(stepDetails, 'quantity') || defaultStepDetails.quantity}
              disabledInterval={Boolean(tier) || Boolean(this.props.interval)}
              disabledAmount={!get(tier, 'presets') && !isNil(get(tier, 'amount') || this.props.fixedAmount)}
              minAmount={this.getOrderMinAmount()}
              maxQuantity={get(tier, 'stats.availableQuantity') || get(tier, 'maxQuantity')}
              showQuantity={tier && tier.type === 'TICKET'}
              showInterval={tier && tier.type !== 'TICKET'}
              customFields={customFields}
              customData={customData}
              onCustomFieldsChange={this.handleCustomFieldsChange}
            />
            {tier && tier.type === 'TICKET' && <EventDetails event={collective} tier={tier} />}
          </Container>
          {interval || isIncognito ? (
            <ContributeDetailsFAQ
              isIncognito={isIncognito}
              hasInterval={!!interval}
              mt={4}
              display={['none', null, 'block']}
              width={1 / 5}
              minWidth="335px"
            />
          ) : (
            <Box width={[0, null, null, 1 / 5]} />
          )}
        </Flex>
      );
    } else if (step.name === 'payment') {
      if (get(stepDetails, 'totalAmount') === 0) {
        return (
          <MessageBox type="success" withIcon>
            {tier.type === 'TICKET' ? (
              <FormattedMessage
                id="contribute.freeTicket"
                defaultMessage="This is a free ticket, you can submit your order directly."
              />
            ) : (
              <FormattedMessage
                id="contribute.freeTier"
                defaultMessage="This is a free tier, you can submit your order directly."
              />
            )}
          </MessageBox>
        );
      } else {
        return (
          <Flex
            flexDirection={['column', null, 'row']}
            alignItems={['center', null, 'flex-start']}
            justifyContent="center"
            width={1}
          >
            <Box width={[0, null, null, 1 / 5]} />
            <Flex flexDirection="column" width={[1, null, 3 / 5]} mx={[1, 3, 5]} css={{ maxWidth: 480 }}>
              <H5 textAlign="left" mb={3}>
                <FormattedMessage id="contribute.payment.label" defaultMessage="Choose a payment method:" />
              </H5>
              <StepPayment
                onChange={stepPayment => this.setState({ stepPayment })}
                collective={stepProfile}
                defaultValue={stepPayment}
                onNewCardFormReady={({ stripe }) => this.setState({ stripe })}
                withPaypal={this.hasPaypal()}
                manual={this.getManualPaymentMethod()}
                hideCreditCardPostalCode={this.shouldHideCreditCardPostalCode()}
                margins="0 auto"
                disabled={this.state.submitting || this.state.submitted}
              />
            </Flex>
            {this.isFixedContribution() ? (
              <ContributionDetails
                totalAmount={get(stepDetails, 'totalAmount')}
                interval={interval}
                currency={this.getCurrency()}
                tax={this.state.stepSummary}
              />
            ) : (
              <Box width={[0, null, null, 1 / 5]} />
            )}
          </Flex>
        );
      }
    } else if (step.name === 'summary') {
      return (
        <Flex
          flexDirection={['column', null, 'row']}
          alignItems={['center', null, 'flex-start']}
          justifyContent="center"
          width={1}
        >
          <Container width={[0, null, null, 1 / 5]} />
          <Container width={[1, null, 3 / 5]} mx={[1, 3, 5]} maxWidth={480}>
            <H5 textAlign="left" mb={3}>
              <FormattedMessage id="contribute.summary.breakdown" defaultMessage="Contribution breakdown:" />
            </H5>
            <StepBreakdown
              amount={get(stepDetails, 'totalAmount')}
              quantity={get(stepDetails, 'quantity')}
              currency={this.getCurrency()}
              hostFeePercent={collective.hostFeePercent}
              paymentMethod={get(stepPayment, 'paymentMethod')}
              onChange={stepSummary => this.setState({ stepSummary })}
              showFees={false}
              tierType={get(tier, 'type')}
              hostCountry={get(host, 'location.country')}
              applyTaxes={true}
              collectiveCountry={
                get(collective.location, 'country') || get(collective, 'parentCollective.location.country')
              }
              userTaxInfo={
                this.state.stepSummary || {
                  countryISO: this.getContributingProfileCountry(),
                  number: get(stepProfile, 'settings.VAT.number'),
                }
              }
            />
          </Container>
          {this.renderTierDetails(tier)}
        </Flex>
      );
    }

    return null;
  }

  renderContent(step, goNext, goBack, isValidating) {
    const { LoggedInUser } = this.props;

    if (!LoggedInUser) {
      return <SignInOrJoinFree />;
    }

    const isPaypal = get(this.state, 'stepPayment.paymentMethod.service') === 'paypal';
    const canGoPrev = !this.state.submitting && !this.state.submitted && !isValidating;
    return (
      <Flex flexDirection="column" alignItems="center" mx={3} width={0.95}>
        {this.renderStep(step)}
        <Flex mt={[4, null, 5]} justifyContent="center" flexWrap="wrap">
          {goBack && (
            <PrevNextButton buttonStyle="standard" disabled={!canGoPrev} onClick={goBack}>
              &larr; <FormattedMessage id="contribute.prevStep" defaultMessage="Previous step" />
            </PrevNextButton>
          )}
          {isPaypal && step.isLastStep ? (
            <PaypalButtonContainer>
              <PayWithPaypalButton
                totalAmount={this.getTotalAmountWithTaxes()}
                currency={this.getCurrency()}
                style={{ size: 'responsive', height: 55 }}
                onClick={() => this.setState({ submitting: true })}
                onAuthorize={pm => this.submitOrder(pm)}
                onCancel={() => this.setState({ submitting: false })}
                onError={e => this.setState({ submitting: false, error: `PayPal error: ${e.message}` })}
              />
            </PaypalButtonContainer>
          ) : (
            <PrevNextButton
              buttonStyle="primary"
              onClick={goNext}
              disabled={!goNext}
              loading={this.state.submitting || this.state.submitted || isValidating}
            >
              {step.isLastStep ? (
                <FormattedMessage id="contribute.submit" defaultMessage="Make contribution" />
              ) : (
                <FormattedMessage id="contribute.nextStep" defaultMessage="Next step" />
              )}{' '}
              &rarr;
            </PrevNextButton>
          )}
        </Flex>
      </Flex>
    );
  }

  render() {
    const { collective, tier, loadingLoggedInUser, LoggedInUser } = this.props;

    return (
      <div>
        <Cover collective={collective} tier={tier} />
        <Steps
          steps={this.getSteps()}
          currentStepName={this.props.step}
          onStepChange={this.onStepChange}
          onInvalidStep={this.onInvalidStep}
          onComplete={this.submitOrder}
        >
          {({ steps, currentStep, lastVisitedStep, goNext, goBack, goToStep, isValidating, isValidStep }) => (
            <Flex id="content" flexDirection="column" alignItems="center" mb={6} p={2}>
              {(loadingLoggedInUser || LoggedInUser) && (
                <Box mb={[3, null, 4]} width={0.8} css={{ maxWidth: 365, minHeight: 95 }}>
                  <ContributionFlowStepsProgress
                    steps={steps}
                    currentStep={currentStep}
                    lastVisitedStep={lastVisitedStep}
                    goToStep={goToStep}
                    stepProfile={this.state.stepProfile}
                    stepDetails={this.state.stepDetails}
                    stepPayment={this.state.stepPayment}
                    submitted={this.state.submitted}
                    loading={loadingLoggedInUser || this.state.loading || this.state.submitting}
                    currency={this.getCurrency()}
                    isFreeTier={this.getOrderMinAmount() === 0}
                  />
                </Box>
              )}
              {this.state.error && (
                <MessageBox type="error" mb={3} mx={2} withIcon>
                  {this.state.error.replace('GraphQL error: ', '')}
                </MessageBox>
              )}
              {loadingLoggedInUser || !isValidStep ? (
                <Loading />
              ) : (
                this.renderContent(currentStep, goNext, goBack, isValidating)
              )}
            </Flex>
          )}
        </Steps>
      </div>
    );
  }
}

export const addCreateOrderMutation = graphql(
  gql`
    mutation createOrder($order: OrderInputType!) {
      createOrder(order: $order) {
        id
        status
        transactions {
          id
        }
      }
    }
  `,
  {
    props: ({ mutate }) => ({
      createOrder: order => mutate({ variables: { order } }),
    }),
  },
);

const addGraphQL = compose(
  addCreateCollectiveMutation,
  addCreateOrderMutation,
);

export default injectIntl(withUser(withStripeLoader(addGraphQL(CreateOrderPage))));
